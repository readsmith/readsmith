/**
 * Derive a stable URL slug from a content file path (relative to the content
 * root). Rules:
 *   - drop the extension
 *   - an `index` or `readme` file maps to its directory (root index -> "")
 *   - lowercase, spaces and unsafe characters collapse to single hyphens
 *   - path separators are preserved as "/"
 */
export function slugFromPath(relPath: string): string {
  const posix = relPath.replace(/\\/g, "/");
  const noExt = posix.replace(/\.(md|mdx)$/i, "");
  const parts = noExt.split("/").filter((p) => p.length > 0);

  const last = parts[parts.length - 1]?.toLowerCase();
  if (last === "index" || last === "readme") parts.pop();

  return parts.map(slugifySegment).join("/");
}

/** Slugify a single path segment: lowercase, non-alphanumeric runs become one hyphen. */
export function slugifySegment(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
