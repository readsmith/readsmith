import { describe, expect, it, vi } from "vitest";
import { isExecError } from "../src/errors.js";
import { type ExecNodeDeps, execNode } from "../src/node.js";
import { buildRequest, redactHeaders } from "../src/request.js";
import type { ExecPolicy } from "../src/types.js";
import { parseTarget } from "../src/url.js";
import { type TargetAllowlist, checkTarget } from "../src/validate.js";

/**
 * The exec-proxy production gate (spec §13): adversarial tests that MUST fail
 * closed. If any of these regress, the primitive is not safe to expose.
 */

const ALLOW: TargetAllowlist = [{ scheme: "https", host: "api.example.com", port: 443 }];

function policy(over: Partial<ExecPolicy> = {}): ExecPolicy {
  return {
    allowlist: ALLOW,
    allowedMethods: ["*"],
    followRedirects: "never",
    maxRedirects: 3,
    timeouts: { connectMs: 1000, totalMs: 2000 },
    maxResponseBytes: 1024,
    maxRequestBytes: 1_000_000,
    ...over,
  };
}

const okSend: NonNullable<ExecNodeDeps["send"]> = async (p, ip) => ({
  ok: true,
  status: 200,
  headers: { "x-pinned": ip },
  body: new Uint8Array(),
  truncated: false,
  timing: { totalMs: 1 },
  finalUrl: p.url,
});

describe("DNS-rebinding defense (SR-5)", () => {
  it("resolves exactly once and pins the first result (no TOCTOU re-resolution)", async () => {
    // A rebinding resolver: public at check time, private if ever asked again.
    const resolve = vi
      .fn<(host: string) => Promise<string[]>>()
      .mockResolvedValueOnce(["93.184.216.34"])
      .mockResolvedValue(["10.0.0.5"]);
    const captured: { ip?: string } = {};
    await execNode({ method: "GET", url: "https://api.example.com/x" }, policy(), {
      resolve,
      send: async (p, ip, o) => {
        captured.ip = ip;
        return okSend(p, ip, o);
      },
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(captured.ip).toBe("93.184.216.34");
  });

  it("fails closed when a host resolves to a mixed public+private set", async () => {
    let sent = false;
    const r = await execNode({ method: "GET", url: "https://api.example.com/x" }, policy(), {
      resolve: async () => ["93.184.216.34", "10.0.0.5"],
      send: async (...a) => {
        sent = true;
        return okSend(...a);
      },
    });
    expect(isExecError(r) && r.code).toBe("DENIED_PRIVATE_IP");
    expect(sent).toBe(false);
  });
});

describe("parser-differential URL corpus (SR-3/SR-6): every entry must be denied", () => {
  const check = (url: string) => {
    const parsed = parseTarget(url);
    return isExecError(parsed) ? parsed : checkTarget(parsed, ALLOW);
  };
  const corpus = [
    "http://169.254.169.254/latest/meta-data/", // cloud metadata
    "http://[::ffff:169.254.169.254]/", // IPv4-mapped metadata
    "http://0x7f000001/", // hex loopback
    "http://2130706433/", // decimal loopback
    "http://017700000001/", // octal loopback
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://100.64.0.1/", // CGNAT
    "http://172.16.0.1/",
    "http://user@127.0.0.1/", // userinfo hides the real host
    "http://api.example.com@169.254.169.254/", // allowlisted-looking userinfo
    "file:///etc/passwd",
    "gopher://127.0.0.1/",
    "ftp://127.0.0.1/",
    "data:text/plain,hi",
    "http://api.example.com\\@evil.com/", // backslash trick
    "http://api.example.com:22/", // allowlisted host, non-allowlisted port
    "http://evil.com/", // not on the allowlist
  ];
  it.each(corpus)("denies %s", (url) => {
    expect(isExecError(check(url))).toBe(true);
  });
});

describe("credential redaction fuzz (SR-10): secrets never leak to logs", () => {
  const secrets = ["sk-live-DEADBEEF1234", "hunter2", "abc123sessiontoken", "p@ssw0rd"];

  it("masks every credential header, whatever the secret", () => {
    for (const secret of secrets) {
      const headers = {
        authorization: `Bearer ${secret}`,
        cookie: `sid=${secret}`,
        "x-api-key": secret,
        accept: "application/json",
      };
      const dump = JSON.stringify(redactHeaders(headers, ["x-api-key"]));
      expect(dump).not.toContain(secret);
    }
  });

  it("carries auth for the real request but masks it in the log view", () => {
    const r = buildRequest({
      method: "GET",
      url: "https://api.example.com/",
      auth: { kind: "basic", username: "u", password: "topsecret" },
    });
    if (isExecError(r)) throw new Error(r.code);
    expect(r.headers.authorization?.startsWith("Basic ")).toBe(true); // present to send
    const logged = JSON.stringify(redactHeaders(r.headers));
    expect(logged).toContain("[redacted]");
    expect(logged).not.toContain(r.headers.authorization ?? "");
  });
});
