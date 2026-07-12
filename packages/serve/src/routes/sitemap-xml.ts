import { getApiReference } from "../api-reference.js";
import { getSite } from "../site.js";

// Regenerate at most once a minute: a published deployment (pointer flip)
// becomes visible without an app rebuild; docs-only output is unchanged.

export async function GET(): Promise<Response> {
  const { build, url } = await getSite();
  const ref = await getApiReference();

  let xml = build.sitemap;
  if (ref) {
    // Add the API reference page just before the closing tag.
    const base = url ? url.replace(/\/+$/, "") : "";
    const loc = `${base}${ref.path}`;
    xml = xml.replace("</urlset>", `  <url><loc>${escapeXml(loc)}</loc></url>\n</urlset>`);
  }

  return new Response(xml, {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
