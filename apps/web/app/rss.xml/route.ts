import { getSite } from "@/lib/site";

export const dynamic = "force-static";

export async function GET() {
  const { build } = await getSite();
  return new Response(build.rss, {
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });
}
