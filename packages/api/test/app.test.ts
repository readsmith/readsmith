import type { SearchHit } from "@readsmith/model";
import { describe, expect, it } from "vitest";
import { createApiApp } from "../src/app.js";
import type { AiServices, ApiDatabase } from "../src/deps.js";

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

describe("createApiApp: health", () => {
  it("reports the database disabled when none is injected", async () => {
    const res = await createApiApp({ db: null, ai: null }).request("/api/health");
    expect(await res.json()).toEqual({ status: "ok", database: "disabled" });
  });

  it("reports up when the database answers", async () => {
    const res = await createApiApp({ db: okDb, ai: null }).request("/api/health");
    expect(await res.json()).toEqual({ status: "ok", database: "up" });
  });

  it("reports degraded (503) when the database errors", async () => {
    const res = await createApiApp({ db: failDb, ai: null }).request("/api/health");
    expect(res.status).toBe(503);
  });
});

describe("createApiApp: capabilities", () => {
  it("reports all-off when AI is unconfigured", async () => {
    const res = await createApiApp({ db: okDb, ai: null }).request("/api/ai/capabilities");
    expect(await res.json()).toEqual({ search: false, vectorSearch: false, askAi: false });
  });

  it("reflects the injected capabilities", async () => {
    const ai = mockAi({ capabilities: { search: true, vectorSearch: false, askAi: false } });
    const res = await createApiApp({ db: okDb, ai }).request("/api/ai/capabilities");
    expect(await res.json()).toEqual({ search: true, vectorSearch: false, askAi: false });
  });
});

describe("createApiApp: search", () => {
  it("returns hits when search is available", async () => {
    const res = await post(createApiApp({ db: okDb, ai: mockAi() }), "/api/search", { query: "x" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: SearchHit[]; degraded: boolean };
    expect(body.hits).toHaveLength(1);
    expect(body.degraded).toBe(false);
  });

  // AC-1.5: a failing embedding provider must not take the endpoint down. The
  // service degrades below us; the route's job is to pass the flag through.
  it("AC-1.5: returns 200 with keyword hits and degraded=true, never 500", async () => {
    const ai = mockAi({ search: async () => ({ hits: [hit], degraded: true }) });
    const res = await post(createApiApp({ db: okDb, ai }), "/api/search", { query: "x" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: SearchHit[]; degraded: boolean };
    expect(body.hits).toHaveLength(1);
    expect(body.degraded).toBe(true);
  });

  it("503s when AI is unconfigured, and when the search capability is off", async () => {
    const off = await post(createApiApp({ db: okDb, ai: null }), "/api/search", { query: "x" });
    expect(off.status).toBe(503);
    const noSearch = mockAi({ capabilities: { search: false, vectorSearch: false, askAi: false } });
    const res = await post(createApiApp({ db: okDb, ai: noSearch }), "/api/search", { query: "x" });
    expect(res.status).toBe(503);
  });

  it("400s on an empty query", async () => {
    const res = await post(createApiApp({ db: okDb, ai: mockAi() }), "/api/search", { query: "" });
    expect(res.status).toBe(400);
  });
});

describe("createApiApp: ask", () => {
  it("streams when Ask-AI is available", async () => {
    const res = await post(createApiApp({ db: okDb, ai: mockAi() }), "/api/ask", { query: "how?" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  it("503s when the chat capability is off", async () => {
    const noChat = mockAi({ capabilities: { search: true, vectorSearch: true, askAi: false } });
    const res = await post(createApiApp({ db: okDb, ai: noChat }), "/api/ask", { query: "how?" });
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
    const res = await post(createApiApp({ db: okDb, ai }), "/api/ai/feedback", {
      id: "q1",
      value: 1,
    });
    expect(res.status).toBe(200);
    expect(captured).toEqual({ id: "q1", value: 1 });
  });

  it("400s without id/value", async () => {
    const res = await post(createApiApp({ db: okDb, ai: mockAi() }), "/api/ai/feedback", {
      id: "q1",
    });
    expect(res.status).toBe(400);
  });
});
