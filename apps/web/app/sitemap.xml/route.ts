import { getApiReference } from "@/lib/api-reference";
import { getSite } from "@/lib/site";

export const dynamic = "force-static";

export async function GET() {
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
