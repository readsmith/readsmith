import { getSite } from "@/lib/site";

export const dynamic = "force-static";

export async function GET() {
  const { build } = await getSite();
  return new Response(build.sitemap, {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
}
