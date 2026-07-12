import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import {
  ASSET_SKIP_EXT,
  ASSET_SKIP_FILES,
  type ResolvedConfig,
  assetPlan,
} from "@readsmith/config";

/** One servable file: where it lives and the site-root-relative path it serves at. */
export interface AssetEntry {
  /** Absolute path of the source file. */
  source: string;
  /** Serving path relative to the site root, forward-slash delimited. */
  key: string;
}

export interface CollectedAssets {
  /** Deterministically ordered (sorted walk), so the same tree always yields the same plan. */
  entries: AssetEntry[];
  /** Declared mounts missing on disk, content-dir-relative (callers warn). */
  missingMounts: string[];
  /** Count of declared (non-root) mounts that existed. */
  mounts: number;
}

async function walk(
  dir: string,
  prefix: string,
  skipContent: boolean,
  out: AssetEntry[],
): Promise<void> {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // .git, dotfiles
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(full, key, skipContent, out);
      continue;
    }
    // Prose and config are inputs to the build, never served as files. A declared
    // mount is copied whole: the operator asked for it by name.
    if (skipContent && ASSET_SKIP_EXT.has(extname(entry.name).toLowerCase())) continue;
    if (skipContent && ASSET_SKIP_FILES.has(entry.name)) continue;
    out.push({ source: full, key });
  }
}

/**
 * Enumerate the static assets a site serves: the content root (prose and
 * config skipped) plus any declared asset mounts. The set of directories is
 * decided by the config, not here, and the walk is shared with the content
 * build so both always agree on where the content root is. Pure enumeration:
 * the caller owns the destination (a public/ dir locally, artifact keys in a
 * deploy).
 */
export async function collectAssets(
  contentDir: string,
  config: ResolvedConfig,
): Promise<CollectedAssets> {
  const entries: AssetEntry[] = [];
  const missingMounts: string[] = [];
  let mounts = 0;
  for (const plan of assetPlan(contentDir, config)) {
    if (!existsSync(plan.dir)) {
      missingMounts.push(relative(contentDir, plan.dir));
      continue;
    }
    await walk(plan.dir, plan.prefix, plan.skipContent, entries);
    if (plan.prefix) mounts += 1;
  }
  return { entries, missingMounts, mounts };
}
