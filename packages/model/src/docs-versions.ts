import { z } from "zod";

/**
 * The documentation-version routing table (multi-version docs). A build emits
 * one per multi-version site; the serve reads it to map a request path to the
 * version whose bundle answers, without loading a bundle first. Single-version
 * sites emit none and serve exactly as before.
 *
 * This is docs content versioning, unrelated to `versioning.ts` (DTO schema
 * versioning). Kept a separate file so the two never blur.
 */

/** One version's routing identity, as the serve needs it (no bundle required). */
export const versionRouteSchema = z.object({
  /** URL-safe id; also the path segment for a non-default version. */
  id: z.string(),
  /** URL segment prefix: "" for the default version, else "/{id}". */
  prefix: z.string(),
  /** True for the version served at the un-prefixed path. */
  isDefault: z.boolean(),
  /** Selector label; defaults to the id at resolve time. */
  label: z.string(),
  tag: z.enum(["latest", "beta", "deprecated"]).optional(),
  /** Built and served at its URL, but omitted from the selector and discovery. */
  hidden: z.boolean(),
  /**
   * The version's non-hidden page slugs, so the version selector can pre-resolve
   * each entry's href server-side (the current slug when it exists in that
   * version, else the version home) without loading every version's bundle.
   * Defaults to empty so an older manifest without it still parses.
   */
  slugs: z.array(z.string()).default([]),
});
export type VersionRoute = z.infer<typeof versionRouteSchema>;

/** A site's version routing table; absent (not present) on single-version sites. */
export const siteVersionsSchema = z.object({
  /** The default version's id (served at the un-prefixed path). */
  default: z.string(),
  list: z.array(versionRouteSchema),
});
export type SiteVersions = z.infer<typeof siteVersionsSchema>;
