import type { SiteBuild } from "@readsmith/mdx";
import type { SiteVersions } from "@readsmith/model";

// Re-exported so multi-tenant hosts have a single import surface (@readsmith/serve)
// for both the resolution helpers and the manifest type they thread together.
export type { SiteVersions, VersionRoute } from "@readsmith/model";

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

/** One entry in the reading shell's version selector, href pre-resolved. */
export interface VersionSelectorItem {
  id: string;
  label: string;
  /** basePath + version prefix + (current slug when it exists there, else home). */
  href: string;
  active: boolean;
  tag?: "latest" | "beta" | "deprecated";
}

/**
 * The version selector's entries, one per non-hidden version, each linking to
 * the current slug in that version when it exists there (FR-11) and otherwise to
 * the version home (FR-9), never a 404. Hrefs are pre-resolved from the manifest
 * (which carries each version's slugs), so the shell needs no client lookup and
 * no other version's bundle. Returns fewer than two entries when there is nothing
 * to switch between; the caller renders no selector then (FR-12).
 */
export function versionSelectorItems(
  versions: SiteVersions,
  activeVersionId: string,
  currentSlug: string,
  basePath = "",
): VersionSelectorItem[] {
  return versions.list
    .filter((v) => !v.hidden)
    .map((v) => {
      const target = v.slugs.includes(currentSlug) ? currentSlug : "";
      const href = `${basePath}${v.prefix}${target ? `/${target}` : ""}` || "/";
      return {
        id: v.id,
        label: v.label,
        href,
        active: v.id === activeVersionId,
        ...(v.tag ? { tag: v.tag } : {}),
      };
    });
}
