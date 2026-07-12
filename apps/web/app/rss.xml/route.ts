import { getSite } from "@/lib/site";

export const dynamic = "force-static";
// Regenerate at most once a minute: a published deployment (pointer flip)
// becomes visible without an app rebuild; docs-only output is unchanged.
export const revalidate = 60;

export async function GET() {
  const { build } = await getSite();
  return new Response(build.rss, {
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });
}
