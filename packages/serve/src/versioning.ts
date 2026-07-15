import type { SiteBuild } from "@readsmith/mdx";
import type { SiteVersions } from "@readsmith/model";

/**
 * Multi-version request routing. Pure over its inputs so both the self-host app
 * and the multi-tenant serve share one mapping from request path to the version
 * whose bundle answers, and it is unit-testable without a store or a DB.
 */

export interface VersionResolution {
  /** The version id whose bundle answers (the manifest default when un-prefixed). */
  versionId: string;
  /** The slug within that version: the version segment stripped, no leading slash. */
  slug: string;
  /**
   * When set, redirect here (a slug path, no basePath) instead of rendering: the
   * default version reached through its own explicit prefix canonicalizes to the
   * bare URL, so there is one canonical per page (FR-19). May be "" (the home).
   */
  canonicalSlug?: string;
}

/**
 * Resolve a request path (host- and basePath-stripped, no leading slash) to the
 * version and slug that answer it. The leading segment selects a version when it
 * matches a known id; the default version reached through its own prefix serves
 * the default content but canonicalizes to the bare path. An unknown leading
 * segment is an ordinary slug in the default version (order: version then slug).
 */
export function resolveVersionRequest(versions: SiteVersions, slug: string): VersionResolution {
  const segments = slug.split("/").filter(Boolean);
  const first = segments[0];
  const match = first ? versions.list.find((v) => v.id === first) : undefined;
  if (!match) return { versionId: versions.default, slug };

  const rest = segments.slice(1).join("/");
  if (match.isDefault) return { versionId: versions.default, slug: rest, canonicalSlug: rest };
  return { versionId: match.id, slug: rest };
}

/**
 * The slug to land on when switching to a version whose `build` is given: the
 * same page when it exists there (and is not hidden), else the version home ("").
 * Never a 404 (FR-9) - the version selector's per-entry href is built from this.
 */
export function versionSwitchTarget(build: SiteBuild, slug: string): string {
  return build.pages.some((p) => p.slug === slug && !p.hidden) ? slug : "";
}
