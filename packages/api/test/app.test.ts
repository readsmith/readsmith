import type { ExecResult } from "@readsmith/exec";
import type { SearchHit } from "@readsmith/model";
import { describe, expect, it } from "vitest";
import { API_BASE_PATH, createApiApp } from "../src/app.js";
import type { AiServices, ApiDatabase, ExecService } from "../src/deps.js";

const okDb: ApiDatabase = { query: async () => [] };
const failDb: ApiDatabase = {
  query: async () => {
    throw new Error("unreachable");
  },
};

const hit: SearchHit = {
  id: "s1",
  kind: "doc",
  title: "Setup",
  snippet: "Set the key.",
  url: "/setup#s",
  anchor: "s",
  headerPath: ["Setup"],
  method: null,
  path: null,
  score: 1,
};

function mockAi(over: Partial<AiServices> = {}): AiServices {
  return {
    capabilities: { search: true, vectorSearch: true, askAi: true },
    search: async () => ({ hits: [hit], degraded: false }),
    ask: async () =>
      new Response("data: hi\n\n", { headers: { "content-type": "text/event-stream" } }),
    feedback: async () => {},
    mcp: async () => new Response("{}"),
    ...over,
  };
}

const post = (app: ReturnType<typeof createApiApp>, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function mockExec(over: Partial<ExecService> = {}): ExecService {
  return {
    enabled: true,
    run: async (): Promise<ExecResult> => ({
      ok: true,
      status: 200,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode('{"ok":true}'),
      truncated: false,
      timing: { totalMs: 5 },
      finalUrl: "https://api.example.com/v1",
    }),
    ...over,
  };
}

describe("createApiApp: proxy (Try It)", () => {
  const REQ = { method: "GET", url: "https://api.example.com/v1" };

  it("returns 503 when the playground is not enabled", async () => {
    const res = await post(createApiApp({ db: okDb, ai: null }), `${API_BASE_PATH}/proxy`, REQ);
    expect(res.status).toBe(503);
  });

  it("relays a successful response as data (base64 body, upstream status in payload)", async () => {
    const res = await post(
      createApiApp({ db: okDb, ai: null, exec: mockExec() }),
      `${API_BASE_PATH}/proxy`,
      REQ,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: number; bodyBase64: string; truncated: boolean };
    expect(json.status).toBe(200);
    expect(atob(json.bodyBase64)).toBe('{"ok":true}');
    expect(json.truncated).toBe(false);
  });

  it("rejects a malformed request body with 400", async () => {
    const res = await post(
      createApiApp({ db: okDb, ai: null, exec: mockExec() }),
      `${API_BASE_PATH}/proxy`,
      {
        method: "GET",
      },
    );
    expect(res.status).toBe(400);
  });

  it("maps an exec deny to 403 with the machine code", async () => {
    const exec = mockExec({
      run: async () => ({ ok: false, code: "DENIED_PRIVATE_IP", message: "blocked" }),
    });
    const res = await post(
      createApiApp({ db: okDb, ai: null, exec }),
      `${API_BASE_PATH}/proxy`,
      REQ,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "DENIED_PRIVATE_IP",
    );
  });

  it("maps an origin timeout to 504", async () => {
    const exec = mockExec({
      run: async () => ({ ok: false, code: "TIMEOUT_TOTAL", message: "timed out" }),
    });
    const res = await post(
      createApiApp({ db: okDb, ai: null, exec }),
      `${API_BASE_PATH}/proxy`,
      REQ,
    );
    expect(res.status).toBe(504);
  });
});

describe("createApiApp: health", () => {
  it("reports the database disabled when none is injected", async () => {
    const res = await createApiApp({ db: null, ai: null }).request(`${API_BASE_PATH}/health`);
    expect(await res.json()).toEqual({ status: "ok", database: "disabled" });
  });

  it("reports up when the database answers", async () => {
    const res = await createApiApp({ db: okDb, ai: null }).request(`${API_BASE_PATH}/health`);
    expect(await res.json()).toEqual({ status: "ok", database: "up" });
  });

  it("reports degraded (503) when the database errors", async () => {
    const res = await createApiApp({ db: failDb, ai: null }).request(`${API_BASE_PATH}/health`);
    expect(res.status).toBe(503);
  });
});

describe("createApiApp: capabilities", () => {
  it("reports all-off when AI is unconfigured", async () => {
    const res = await createApiApp({ db: okDb, ai: null }).request(
      `${API_BASE_PATH}/ai/capabilities`,
    );
    expect(await res.json()).toEqual({ search: false, vectorSearch: false, askAi: false });
  });

  it("reflects the injected capabilities", async () => {
    const ai = mockAi({ capabilities: { search: true, vectorSearch: false, askAi: false } });
    const res = await createApiApp({ db: okDb, ai }).request(`${API_BASE_PATH}/ai/capabilities`);
    expect(await res.json()).toEqual({ search: true, vectorSearch: false, askAi: false });
  });
});

describe("createApiApp: search", () => {
  it("returns hits when search is available", async () => {
    const res = await post(createApiApp({ db: okDb, ai: mockAi() }), `${API_BASE_PATH}/search`, {
      query: "x",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: SearchHit[]; degraded: boolean };
    expect(body.hits).toHaveLength(1);
    expect(body.degraded).toBe(false);
  });

  // AC-1.5: a failing embedding provider must not take the endpoint down. The
  // service degrades below us; the route's job is to pass the flag through.
  it("AC-1.5: returns 200 with keyword hits and degraded=true, never 500", async () => {
    const ai = mockAi({ search: async () => ({ hits: [hit], degraded: true }) });
    const res = await post(createApiApp({ db: okDb, ai }), `${API_BASE_PATH}/search`, {
      query: "x",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: SearchHit[]; degraded: boolean };
    expect(body.hits).toHaveLength(1);
    expect(body.degraded).toBe(true);
  });

  it("503s when AI is unconfigured, and when the search capability is off", async () => {
    const off = await post(createApiApp({ db: okDb, ai: null }), `${API_BASE_PATH}/search`, {
      query: "x",
    });
    expect(off.status).toBe(503);
    const noSearch = mockAi({ capabilities: { search: false, vectorSearch: false, askAi: false } });
    const res = await post(createApiApp({ db: okDb, ai: noSearch }), `${API_BASE_PATH}/search`, {
      query: "x",
    });
    expect(res.status).toBe(503);
  });

  it("400s on an empty query", async () => {
    const res = await post(createApiApp({ db: okDb, ai: mockAi() }), `${API_BASE_PATH}/search`, {
      query: "",
    });
    expect(res.status).toBe(400);
  });
});

describe("createApiApp: ask", () => {
  it("streams when Ask-AI is available", async () => {
    const res = await post(createApiApp({ db: okDb, ai: mockAi() }), `${API_BASE_PATH}/ask`, {
      query: "how?",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  it("503s when the chat capability is off", async () => {
    const noChat = mockAi({ capabilities: { search: true, vectorSearch: true, askAi: false } });
    const res = await post(createApiApp({ db: okDb, ai: noChat }), `${API_BASE_PATH}/ask`, {
      query: "how?",
    });
    expect(res.status).toBe(503);
  });
});

describe("createApiApp: feedback", () => {
  it("records a thumbs signal", async () => {
    let captured: { id: string; value: number } | null = null;
    const ai = mockAi({
      feedback: async (input) => {
        captured = input;
      },
    });
    const res = await post(createApiApp({ db: okDb, ai }), `${API_BASE_PATH}/ai/feedback`, {
      id: "q1",
      value: 1,
    });
    expect(res.status).toBe(200);
    expect(captured).toEqual({ id: "q1", value: 1 });
  });

  it("400s without id/value", async () => {
    const res = await post(
      createApiApp({ db: okDb, ai: mockAi() }),
      `${API_BASE_PATH}/ai/feedback`,
      {
        id: "q1",
      },
    );
    expect(res.status).toBe(400);
  });
});

describe("git webhook route", () => {
  it("404s when git is not configured", async () => {
    const app = createApiApp({ db: okDb, ai: null });
    const res = await app.request(`${API_BASE_PATH}/git/webhook`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });

  it("delegates to the injected service with the raw request", async () => {
    let seen: string | null = null;
    const app = createApiApp({
      db: okDb,
      ai: null,
      git: {
        webhook: async (req) => {
          seen = await req.text();
          return new Response(null, { status: 202 });
        },
      },
    });
    const res = await app.request(`${API_BASE_PATH}/git/webhook`, {
      method: "POST",
      body: '{"x":1}',
    });
    expect(res.status).toBe(202);
    expect(seen).toBe('{"x":1}');
  });
});

describe("page feedback route", () => {
  it("validates input, persists through the service, and drops without one", async () => {
    const seen: { path: string; helpful: boolean }[] = [];
    const app = createApiApp({
      db: okDb,
      ai: null,
      analytics: {
        pageFeedback: async (input) => {
          seen.push(input);
        },
      },
    });
    const bad = await post(app, `${API_BASE_PATH}/page-feedback`, { path: "" });
    expect(bad.status).toBe(400);
    const ok = await post(app, `${API_BASE_PATH}/page-feedback`, {
      path: "/quickstart",
      helpful: true,
    });
    expect(ok.status).toBe(202);
    expect(seen).toEqual([{ path: "/quickstart", helpful: true }]);

    const bare = createApiApp({ db: okDb, ai: null });
    const dropped = await post(bare, `${API_BASE_PATH}/page-feedback`, {
      path: "/x",
      helpful: false,
    });
    expect(dropped.status).toBe(202);
  });
});
