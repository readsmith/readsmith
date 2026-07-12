import { getSite } from "@/lib/site";

export const dynamic = "force-static";
// Regenerate at most once a minute: a published deployment (pointer flip)
// becomes visible without an app rebuild; docs-only output is unchanged.
export const revalidate = 60;

export async function GET() {
  const { url } = await getSite();
  const base = url ? url.replace(/\/+$/, "") : "";
  const sitemap = `${base}/sitemap.xml`;
  const body = `User-agent: *\nAllow: /\n\nSitemap: ${sitemap}\n`;
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
