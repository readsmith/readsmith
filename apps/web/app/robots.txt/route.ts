import { getSite } from "@/lib/site";

export const dynamic = "force-static";

export async function GET() {
  const { url } = await getSite();
  const base = url ? url.replace(/\/+$/, "") : "";
  const sitemap = `${base}/sitemap.xml`;
  const body = `User-agent: *\nAllow: /\n\nSitemap: ${sitemap}\n`;
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
