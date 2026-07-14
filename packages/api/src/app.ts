import {
  type ExecError,
  type ExecErrorCode,
  type ExecResult,
  isExecError,
  parseProxyRequest,
} from "@readsmith/exec";
import { Hono } from "hono";
import { z } from "zod";
import type { ApiDeps } from "./deps.js";
import { rateLimitMiddleware } from "./rate-limit.js";

/** Map an exec deny/limit/timeout to a caller-facing HTTP status. */
function statusForExecError(code: ExecErrorCode): 400 | 403 | 413 | 429 | 502 | 504 {
  switch (code) {
    case "DENIED_SCHEME":
    case "DENIED_MALFORMED_URL":
      return 400;
    case "DENIED_NOT_ALLOWLISTED":
    case "DENIED_PRIVATE_IP":
    case "DENIED_PORT":
    case "DENIED_METHOD":
    case "DENIED_REDIRECT_TARGET":
      return 403;
    case "LIMIT_SIZE_REQUEST":
      return 413;
    case "LIMIT_RATE":
      return 429;
    case "TIMEOUT_CONNECT":
    case "TIMEOUT_TOTAL":
      return 504;
    default:
      return 502; // ORIGIN_*, LIMIT_SIZE_RESPONSE
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Shape the executor's result for the browser. The upstream response is DATA in
 * our JSON body (status/headers/base64 body), never re-emitted as our own
 * response headers, so a `Set-Cookie` from the target can never set a cookie on
 * our origin (spec SR-13). Our own HTTP status is 200 when the call completed;
 * the target's status lives in the payload.
 */
function proxyResponse(result: ExecResult | ExecError): Response {
  if (isExecError(result)) {
    return Response.json(
      { error: { code: result.code, message: result.message } },
      { status: statusForExecError(result.code) },
    );
  }
  return Response.json({
    status: result.status,
    headers: result.headers,
    bodyBase64: toBase64(result.body),
    truncated: result.truncated,
    timing: result.timing,
    finalUrl: result.finalUrl,
  });
}

/**
 * Where the JSON API is mounted.
 *
 * Not `/api`. A documentation site is the one kind of site most likely to have a
 * page called `api.md`, and mounting here would reserve `/api` and everything
 * under it, shadowing that page and any `docs/api/` folder. The reading shell is
 * the only client, so the path is an implementation detail rather than a contract.
 */
export const API_BASE_PATH = "/_readsmith/api";

export interface ApiAppOptions {
  /** Override the mount point. Must match the host's route file location. */
  basePath?: string;
}

const scopedQuery = z.object({
  query: z.string().min(1).max(2000),
  version: z.string().optional(),
  locale: z.string().optional(),
});
const feedbackInput = z.object({ id: z.string().min(1), value: z.number().int() });
const pageFeedbackInput = z.object({
  path: z.string().min(1).max(500),
  helpful: z.boolean(),
  comment: z.string().max(2000).optional(),
});

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
 * via `deps.ai.mcp` (outside this base path), and the host enforces the `mcp`
 * bucket there with the same limiter.
 *
 * The rate limiter runs ahead of the capability check so that every priced route
 * is guarded uniformly, including the paths that fail closed.
 */
export function createApiApp(deps: ApiDeps, options: ApiAppOptions = {}): Hono {
  const app = new Hono().basePath(options.basePath ?? API_BASE_PATH);
  const limiter = deps.rateLimit ?? null;
  const limit = (bucket: "ask" | "search" | "exec") =>
    rateLimitMiddleware(limiter, bucket, deps.clientAddress);

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

  // "Was this page helpful": persisted when a database exists, acked and
  // dropped otherwise - the reader's gesture never errors. Shares the search
  // rate bucket (both are cheap, reader-initiated writes).
  app.post("/page-feedback", limit("search"), async (c) => {
    const body = pageFeedbackInput.safeParse(await parseJson(c.req.raw));
    if (!body.success) return c.json({ error: "path and helpful are required." }, 400);
    if (!deps.analytics) return c.json({ ignored: "no persistence" }, 202);
    await deps.analytics.pageFeedback(body.data);
    return c.json({ ok: true }, 202);
  });

  // Inbound git-provider webhooks. The service owns signature verification (it
  // needs the raw bytes) and does minimal work: verify, filter, enqueue.
  app.post("/git/webhook", async (c) => {
    if (!deps.git) return c.json({ error: "Git integration is not configured." }, 404);
    return deps.git.webhook(c.req.raw);
  });

  // Hybrid search for the command palette. No LLM. Returns `degraded: true` when
  // the vector arm was expected but the provider failed, so the UI can say the
  // results are keyword-only instead of silently serving worse ones.
  app.post("/search", limit("search"), async (c) => {
    if (!deps.ai?.capabilities.search) {
      return c.json({ error: "Search is not available on this site." }, 503);
    }
    const body = scopedQuery.safeParse(await parseJson(c.req.raw));
    if (!body.success) return c.json({ error: "A non-empty query is required." }, 400);
    const result = await deps.ai.search(body.data);
    return c.json(result);
  });

  // Ask-AI: a streamed answer (SSE UI message stream from the host).
  app.post("/ask", limit("ask"), async (c) => {
    if (!deps.ai?.capabilities.askAi) {
      return c.json({ error: "Ask-AI is not available on this site." }, 503);
    }
    const body = scopedQuery.safeParse(await parseJson(c.req.raw));
    if (!body.success) return c.json({ error: "A non-empty query is required." }, 400);
    return deps.ai.ask(body.data);
  });

  // API playground "Try It": send the reader's request through the SSRF-safe
  // proxy and return the response as data. The rate limiter runs first (each
  // call is an outbound request on our IP); the executor (host-composed with
  // this site's allowlist) owns all target validation.
  app.post("/proxy", limit("exec"), async (c) => {
    if (!deps.exec?.enabled) {
      return c.json({ error: "The API playground is not available on this site." }, 503);
    }
    const parsed = parseProxyRequest(await parseJson(c.req.raw));
    if (isExecError(parsed)) {
      return c.json({ error: { code: parsed.code, message: parsed.message } }, 400);
    }
    return proxyResponse(await deps.exec.run(parsed));
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
