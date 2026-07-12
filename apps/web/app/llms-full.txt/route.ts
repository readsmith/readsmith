import { getSite } from "@/lib/site";

export const dynamic = "force-static";
// Regenerate at most once a minute: a published deployment (pointer flip)
// becomes visible without an app rebuild; docs-only output is unchanged.
export const revalidate = 60;

export async function GET() {
  const { build } = await getSite();
  return new Response(build.llmsFullTxt, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
