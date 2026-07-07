import { getAiServices } from "@/lib/ai";

// The MCP server is served at /mcp (outside the /api base path) over the
// Streamable-HTTP transport, read-only. It is a projection of the same indexes
// the UI uses, so it needs the DB-backed AI services.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handler(request: Request): Promise<Response> {
  const ai = await getAiServices();
  if (!ai) {
    return Response.json({ error: "MCP is not available on this site." }, { status: 503 });
  }
  return ai.mcp(request);
}

export const GET = handler;
export const POST = handler;
