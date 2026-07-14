import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/*
 * Build-time filesystem access to the bundled Lucide icon set. Kept here (not in
 * @readsmith/components, which also sources the browser islands) so the icon
 * renderer stays edge-safe: only the site compiler, which runs in Node, touches
 * the filesystem. Only names an actual page references are ever read, so the set
 * is tree-shaken by construction and nothing extra ships to the client.
 */

const require = createRequire(import.meta.url);
let iconsDir: string | undefined;

function resolveIconsDir(): string {
  if (iconsDir === undefined) {
    iconsDir = require.resolve("lucide-static/package.json").replace(/package\.json$/, "icons");
  }
  return iconsDir;
}

// Kebab-case names only: this is a filename, so the guard also blocks traversal.
const SAFE_NAME = /^[a-z0-9-]+$/;

/** Read a Lucide icon's raw SVG by kebab name, or undefined if invalid/absent. */
export function readLucideSvg(name: string): string | undefined {
  if (!SAFE_NAME.test(name)) return undefined;
  try {
    return readFileSync(`${resolveIconsDir()}/${name}.svg`, "utf8");
  } catch {
    return undefined;
  }
}
