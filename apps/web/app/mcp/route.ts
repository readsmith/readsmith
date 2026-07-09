import { getAiServices } from "@/lib/ai";
import { getRateLimiter } from "@/lib/rate-limit";
import { rateLimitResponse } from "@readsmith/api";

// The MCP server is served at /mcp (outside the /api base path) over the
// Streamable-HTTP transport, read-only. It is a projection of the same indexes
// the UI uses, so it needs the DB-backed AI services. Because it sits outside the
// Hono app, the host applies the `mcp` bucket of the same shared limiter here.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handler(request: Request): Promise<Response> {
  const ai = await getAiServices();
  if (!ai) {
    return Response.json({ error: "MCP is not available on this site." }, { status: 503 });
  }
  const limiter = await getRateLimiter();
  const decision = await limiter.check("mcp", request.headers);
  if (!decision.allowed) return rateLimitResponse(decision);

  try {
    return await ai.mcp(request);
  } catch (err) {
    console.error("[readsmith] MCP request failed:", err);
    return Response.json({ error: "MCP request failed." }, { status: 500 });
  }
}

// Streamable-HTTP uses POST for messages, GET to open the stream, and DELETE to
// end a session; the transport handles all three.
export const GET = handler;
export const POST = handler;
export const DELETE = handler;
