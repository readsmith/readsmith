import { getAiServices } from "@/lib/ai";
import { getDb } from "@/lib/db";
import { createApiApp } from "@readsmith/api";

// The API surface runs on the Node.js runtime (it talks to Postgres and the AI
// providers). The shared routes live in @readsmith/api; here we inject the Node
// database and the composed AI services, then serve via Hono's web fetch. The
// app is built once (async, to load the bundle) and reused.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let appPromise: Promise<ReturnType<typeof createApiApp>> | undefined;

function getApp(): Promise<ReturnType<typeof createApiApp>> {
  if (!appPromise) {
    appPromise = getAiServices().then((ai) => createApiApp({ db: getDb(), ai }));
  }
  return appPromise;
}

async function handler(request: Request): Promise<Response> {
  return (await getApp()).fetch(request);
}

export const GET = handler;
export const POST = handler;
