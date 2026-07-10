import type { Diagnostic } from "@readsmith/model";
import type { PageRef } from "./schema.js";

/**
 * URLs the Readsmith web app serves itself. A docs page whose slug lands on one
 * of these is unreachable, and in Next.js the collision breaks the endpoint too:
 * the router finds both a static page and a route handler for the same path and
 * throws. Nothing warns you, so we do.
 *
 * The JSON API deliberately does not appear here. It is mounted under
 * `/_readsmith/api` precisely so that `/api` and `docs/api/**` stay yours.
 */
export const RESERVED_PATHS = [
  "/_readsmith",
  "/_next",
  "/md",
  "/api-reference",
  "/llms.txt",
  "/llms-full.txt",
  "/skill.md",
  "/robots.txt",
  "/rss.xml",
  "/sitemap.xml",
] as const;

/**
 * Paths the app would like, but yields to your content. `/mcp` is the convention
 * MCP clients expect, so it is offered as an alias when free. A `docs/mcp.md`
 * takes it, and the endpoint stays reachable at its canonical `/_readsmith/mcp`.
 */
export const SOFT_RESERVED_PATHS = ["/mcp"] as const;

/** Where the MCP server always answers, whatever the alias resolves to. */
export const MCP_CANONICAL_PATH = "/_readsmith/mcp";

function pageUrl(slug: string): string {
  return slug === "" ? "/" : `/${slug}`;
}

/** True when `url` is the reserved path itself, or sits beneath it. */
function claims(url: string, reserved: string): boolean {
  return url === reserved || url.startsWith(`${reserved}/`);
}

/**
 * Report pages that collide with a path the app serves. Hard conflicts are
 * errors: the page cannot be reached and the route it shadows will 500. The soft
 * conflict is informational, because the page wins and nothing breaks.
 */
export function reservedPathConflicts(pages: PageRef[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const page of pages) {
    const url = pageUrl(page.slug);
    for (const reserved of RESERVED_PATHS) {
      if (!claims(url, reserved)) continue;
      out.push({
        severity: "error",
        code: "reserved-path",
        message: `Page "${page.path}" resolves to "${url}", which Readsmith serves itself. Rename the file or exclude it.`,
        source: page.path,
      });
    }
    for (const reserved of SOFT_RESERVED_PATHS) {
      if (url !== reserved) continue;
      out.push({
        severity: "warning",
        code: "reserved-path",
        message: `Page "${page.path}" takes "${url}". The MCP endpoint moves to "${MCP_CANONICAL_PATH}"; point MCP clients there.`,
        source: page.path,
      });
    }
  }
  return out;
}

/**
 * The alias the MCP endpoint should be exposed at, or null when a docs page has
 * claimed it. `custom` comes from `docs.yaml` `mcp.path`.
 */
export function mcpAlias(pages: PageRef[], custom?: string): string | null {
  const want = custom ?? SOFT_RESERVED_PATHS[0];
  const taken = new Set(pages.map((p) => pageUrl(p.slug)));
  return taken.has(want) ? null : want;
}
