import { Hono } from "hono";
import { z } from "zod";
import type { ApiDeps } from "./deps.js";

const scopedQuery = z.object({
  query: z.string().min(1),
  version: z.string().optional(),
  locale: z.string().optional(),
});
const feedbackInput = z.object({ id: z.string().min(1), value: z.number().int() });

async function parseJson(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
}

/**
 * Build the API as a Hono app over injected dependencies. The app is mounted by
 * a host (which adapts it to the host's request lifecycle) and carries no
 * knowledge of that host. Routes read from `deps`, so persistence and other
 * services are provided from the outside. Mounted under `/api`.
 *
 * M3 adds search, Ask-AI, and feedback; each fails closed with a keyless message
 * when its capability is off (the degradation ladder). MCP is served by the host
 * at `/mcp` via `deps.ai.mcp` (outside this `/api` base path).
 */
export function createApiApp(deps: ApiDeps): Hono {
  const app = new Hono().basePath("/api");

  app.get("/health", async (c) => {
    if (!deps.db) return c.json({ status: "ok", database: "disabled" });
    try {
      await deps.db.query({ text: "SELECT 1", values: [] });
      return c.json({ status: "ok", database: "up" });
    } catch {
      return c.json({ status: "degraded", database: "down" }, 503);
    }
  });

  // Which AI capabilities are live, so the static shell shows/hides the right
  // controls (the degradation ladder). Always answers; defaults to all-off.
  app.get("/ai/capabilities", (c) => {
    return c.json(deps.ai?.capabilities ?? { search: false, vectorSearch: false, askAi: false });
  });

  // Hybrid search for the command palette. No LLM.
  app.post("/search", async (c) => {
    if (!deps.ai?.capabilities.search) {
      return c.json({ error: "Search is not available on this site." }, 503);
    }
    const body = scopedQuery.safeParse(await parseJson(c.req.raw));
    if (!body.success) return c.json({ error: "A non-empty query is required." }, 400);
    const hits = await deps.ai.search(body.data);
    return c.json({ hits });
  });

  // Ask-AI: a streamed answer (SSE UI message stream from the host).
  app.post("/ask", async (c) => {
    if (!deps.ai?.capabilities.askAi) {
      return c.json({ error: "Ask-AI is not available on this site." }, 503);
    }
    const body = scopedQuery.safeParse(await parseJson(c.req.raw));
    if (!body.success) return c.json({ error: "A non-empty query is required." }, 400);
    return deps.ai.ask(body.data);
  });

  // A reader's thumbs signal on a logged answer.
  app.post("/ai/feedback", async (c) => {
    if (!deps.ai) return c.json({ error: "Ask-AI is not available on this site." }, 503);
    const body = feedbackInput.safeParse(await parseJson(c.req.raw));
    if (!body.success) return c.json({ error: "id and value are required." }, 400);
    await deps.ai.feedback(body.data);
    return c.json({ ok: true });
  });

  return app;
}
