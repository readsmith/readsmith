import { glob } from "tinyglobby";
import type { PageRef } from "./schema.js";
import { slugFromPath } from "./slug.js";

/**
 * Discover content files under `root` matching `include` (minus `exclude`) and
 * derive each page's slug. Results are sorted by path for deterministic output
 * across runs and operating systems (never rely on filesystem enumeration order).
 */
export async function discoverPages(
  root: string,
  include: string[],
  exclude: string[],
): Promise<PageRef[]> {
  const matches = await glob(include, {
    cwd: root,
    ignore: exclude,
    dot: false,
    onlyFiles: true,
  });

  const sorted = [...matches].sort((a, b) => a.localeCompare(b));
  return sorted.map((path) => ({
    path: path.replace(/\\/g, "/"),
    slug: slugFromPath(path),
  }));
}
