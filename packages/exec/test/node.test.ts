import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isExecError } from "../src/errors.js";
import {
  type ExecNodeDeps,
  createExecService,
  execNode,
  planRedirect,
  sendPinned,
} from "../src/node.js";
import { buildRequest } from "../src/request.js";
import type { ExecPolicy, ExecRequest, ExecResult, PreparedRequest } from "../src/types.js";

const dec = new TextDecoder();

function prepared(req: ExecRequest): PreparedRequest {
  const r = buildRequest(req);
  if (isExecError(r)) throw new Error(`build failed: ${r.code}`);
  return r;
}

const SEND_OPTS = { timeouts: { connectMs: 2000, totalMs: 5000 }, maxResponseBytes: 1024 };

function policy(over: Partial<ExecPolicy> = {}): ExecPolicy {
  return {
    allowlist: [{ scheme: "https", host: "api.example.com", port: 443 }],
    allowedMethods: ["*"],
    followRedirects: "never",
    maxRedirects: 3,
    timeouts: { connectMs: 2000, totalMs: 5000 },
    maxResponseBytes: 1024,
    maxRequestBytes: 1_000_000,
    ...over,
  };
}

// A local origin, reached directly via sendPinned (which does not validate, so
// loopback is fine here). This exercises the real HTTP send path.
describe("sendPinned (real HTTP against a local origin)", () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(5000));
        return;
      }
      if (req.url === "/echo") {
        const parts: Buffer[] = [];
        req.on("data", (c) => parts.push(c));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json", "x-method": req.method ?? "" });
          res.end(JSON.stringify({ body: Buffer.concat(parts).toString("utf8") }));
        });
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("returns status, headers, body, and timing", async () => {
    const r = await sendPinned(
      prepared({ method: "GET", url: `http://127.0.0.1:${port}/` }),
      "127.0.0.1",
      SEND_OPTS,
    );
    if (isExecError(r)) throw new Error(r.code);
    expect(r.status).toBe(200);
    expect(dec.decode(r.body)).toBe("hello");
    expect(r.headers["content-type"]).toBe("text/plain");
    expect(r.timing.totalMs).toBeGreaterThanOrEqual(0);
    expect(r.truncated).toBe(false);
  });

  it("sends the request body", async () => {
    const r = await sendPinned(
      prepared({
        method: "POST",
        url: `http://127.0.0.1:${port}/echo`,
        body: { kind: "raw", value: "PING" },
      }),
      "127.0.0.1",
      SEND_OPTS,
    );
    if (isExecError(r)) throw new Error(r.code);
    expect(JSON.parse(dec.decode(r.body))).toEqual({ body: "PING" });
  });

  it("truncates the response exactly at maxResponseBytes (AC-4)", async () => {
    const r = await sendPinned(
      prepared({ method: "GET", url: `http://127.0.0.1:${port}/big` }),
      "127.0.0.1",
      {
        ...SEND_OPTS,
        maxResponseBytes: 100,
      },
    );
    if (isExecError(r)) throw new Error(r.code);
    expect(r.body.length).toBe(100);
    expect(r.truncated).toBe(true);
  });

  it("maps a refused connection to ORIGIN_UNREACHABLE", async () => {
    // Port 1 is not listening; connect fails fast.
    const r = await sendPinned(
      prepared({ method: "GET", url: "http://127.0.0.1:1/" }),
      "127.0.0.1",
      SEND_OPTS,
    );
    expect(isExecError(r) && r.code).toBe("ORIGIN_UNREACHABLE");
  });
});

describe("execNode orchestration (injected resolve/send)", () => {
  const fakeSend: ExecNodeDeps["send"] = async (p, ip) => ({
    ok: true,
    status: 200,
    headers: { "x-pinned": ip },
    body: new Uint8Array(),
    truncated: false,
    timing: { totalMs: 1 },
    finalUrl: p.url,
  });

  it("resolves a domain, validates the IP, and pins the send to it (SR-5 happy path)", async () => {
    const captured: { ip?: string } = {};
    const deps: ExecNodeDeps = {
      resolve: async () => ["93.184.216.34"],
      send: async (p, ip, o) => {
        captured.ip = ip;
        return (fakeSend as NonNullable<ExecNodeDeps["send"]>)(p, ip, o);
      },
    };
    const r = (await execNode(
      { method: "GET", url: "https://api.example.com/v1" },
      policy(),
      deps,
    )) as ExecResult;
    expect(isExecError(r)).toBe(false);
    expect(captured.ip).toBe("93.184.216.34");
  });

  it("denies a domain that resolves to a private IP, and never sends (SR-5)", async () => {
    let sendCalled = false;
    const deps: ExecNodeDeps = {
      resolve: async () => ["10.0.0.5"],
      send: async (...a) => {
        sendCalled = true;
        return (fakeSend as NonNullable<ExecNodeDeps["send"]>)(...a);
      },
    };
    const r = await execNode({ method: "GET", url: "https://api.example.com/v1" }, policy(), deps);
    expect(isExecError(r) && r.code).toBe("DENIED_PRIVATE_IP");
    expect(sendCalled).toBe(false);
  });

  it("enforces the method gate (DENIED_METHOD)", async () => {
    const r = await execNode(
      { method: "DELETE", url: "https://api.example.com/v1" },
      policy({ allowedMethods: ["GET", "HEAD"] }),
      { send: fakeSend, resolve: async () => ["93.184.216.34"] },
    );
    expect(isExecError(r) && r.code).toBe("DENIED_METHOD");
  });

  it("denies an unallowlisted host before resolving", async () => {
    let resolveCalled = false;
    const r = await execNode({ method: "GET", url: "https://evil.com/" }, policy(), {
      resolve: async () => {
        resolveCalled = true;
        return ["93.184.216.34"];
      },
      send: fakeSend,
    });
    expect(isExecError(r) && r.code).toBe("DENIED_NOT_ALLOWLISTED");
    expect(resolveCalled).toBe(false);
  });
});

describe("createExecService (host composition)", () => {
  it("is disabled when the site declares no servers", () => {
    expect(createExecService({ allowlist: [] }).enabled).toBe(false);
  });

  it("is enabled with servers and denies an off-allowlist target without any network", async () => {
    const svc = createExecService({
      allowlist: [{ scheme: "https", host: "api.example.com", port: 443 }],
    });
    expect(svc.enabled).toBe(true);
    const r = await svc.run({ method: "GET", url: "https://evil.com/" });
    expect(isExecError(r) && r.code).toBe("DENIED_NOT_ALLOWLISTED");
  });
});

describe("planRedirect (SR-12)", () => {
  const base: ExecRequest = {
    method: "GET",
    url: "https://a.example.com/1",
    headers: { authorization: "Bearer secret", accept: "application/json" },
    auth: { kind: "bearer", token: "secret" },
  };

  it("keeps credentials on a same-origin redirect", () => {
    const next = planRedirect(base, "https://a.example.com/1", 302, "/2");
    expect(next?.url).toBe("https://a.example.com/2");
    expect(next?.headers?.authorization).toBe("Bearer secret");
    expect(next?.auth).toEqual({ kind: "bearer", token: "secret" });
  });

  it("strips Authorization on a cross-origin redirect (AC-12)", () => {
    const next = planRedirect(base, "https://a.example.com/1", 302, "https://b.other.com/x");
    expect(next?.url).toBe("https://b.other.com/x");
    expect(next?.headers?.authorization).toBeUndefined();
    expect(next?.auth).toEqual({ kind: "none" });
  });

  it("303 becomes a bodyless GET", () => {
    const post: ExecRequest = {
      method: "POST",
      url: "https://a.example.com/1",
      body: { kind: "json", value: {} },
    };
    const next = planRedirect(post, "https://a.example.com/1", 303, "/done");
    expect(next?.method).toBe("GET");
    expect(next?.body).toBeUndefined();
  });

  it("returns null when there is no Location", () => {
    expect(planRedirect(base, "https://a.example.com/1", 302, undefined)).toBeNull();
  });
});
