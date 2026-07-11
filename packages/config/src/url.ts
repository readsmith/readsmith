/**
 * Subpath hosting (spec subpath-hosting SP-1/SP-2). A site served under a
 * parent domain's path (`example.com/docs`) declares it through `site.url`;
 * these helpers split that one source of truth into the two pieces every URL
 * composition needs: the base path that page URLs carry, and the origin that
 * absolute URLs are built from. Composing `site.url + path` would double the
 * prefix; the rule is always `origin + already-prefixed path`.
 */

/** The base path from a site URL: "https://a.dev/docs" -> "/docs"; no path -> "". */
export function siteBasePath(url: string | undefined): string {
  if (!url) return "";
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    return path === "" || path === "/" ? "" : path;
  } catch {
    return "";
  }
}

/** The origin from a site URL: "https://a.dev/docs" -> "https://a.dev"; invalid -> "". */
export function siteOrigin(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}
