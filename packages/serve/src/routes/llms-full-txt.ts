import { getSite } from "../site.js";

// Regenerate at most once a minute: a published deployment (pointer flip)
// becomes visible without an app rebuild; docs-only output is unchanged.

export async function GET(): Promise<Response> {
  const { build } = await getSite();
  return new Response(build.llmsFullTxt, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
