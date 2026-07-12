import { siteBasePath } from "@readsmith/config";
import { getSite } from "../site.js";

/**
 * The bare discovery directory: humans and probing agents who request
 * /.well-known/skills (no file) land on the index instead of a 404.
 */
// Regenerate at most once a minute: a published deployment (pointer flip)
// becomes visible without an app rebuild; docs-only output is unchanged.

export async function GET(): Promise<Response> {
  // Location headers are not basePath-scoped by Next; prefix explicitly.
  const base = siteBasePath((await getSite()).url);
  return new Response(null, {
    status: 308,
    headers: { location: `${base}/.well-known/skills/index.json` },
  });
}
