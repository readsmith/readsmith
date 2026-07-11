/**
 * The default favicon: the Readsmith hallmark in gold, served when a site
 * configures no `site.favicon`. Lives under the private /_readsmith prefix
 * (public/ is generated and cleared each run, so no static file can). The
 * gold midtone reads on both light and dark browser chrome.
 */
export const dynamic = "force-static";

// The header hallmark's geometry (see @readsmith/components shell/util.ts),
// with strokes thickened from 1.6/2 so the mark survives 16px rendering.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M16 2.5 L27.5 9 V23 L16 29.5 L4.5 23 V9 Z" fill="none" stroke="#C28E3F" stroke-width="2.6" stroke-linejoin="round"/><path d="M11 16.2 L14.6 20 L21.3 11.6" fill="none" stroke="#C28E3F" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function GET(): Response {
  return new Response(SVG, {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=86400",
    },
  });
}
