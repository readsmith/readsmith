import { getSite } from "@/lib/site";
import { siteBasePath } from "@readsmith/config";

/**
 * The bare discovery directory: humans and probing agents who request
 * /.well-known/skills (no file) land on the index instead of a 404.
 */
export const dynamic = "force-static";

export async function GET() {
  // Location headers are not basePath-scoped by Next; prefix explicitly.
  const base = siteBasePath((await getSite()).url);
  return new Response(null, {
    status: 308,
    headers: { location: `${base}/.well-known/skills/index.json` },
  });
}
