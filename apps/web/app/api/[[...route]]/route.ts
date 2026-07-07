import { getDb } from "@/lib/db";
import { createApiApp } from "@readsmith/api";
import { handle } from "hono/vercel";

// The API surface runs on the Node.js runtime (it talks to Postgres). The shared
// routes live in @readsmith/api; here we inject the Node database and adapt the
// Hono app to Next. The full API (search, Ask-AI, MCP) arrives in M3.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const app = createApiApp({ db: getDb() });

export const GET = handle(app);
