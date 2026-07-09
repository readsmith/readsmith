// Publish static assets into public/, and nothing else.
//
// The set of directories whose files may be served is decided by the config, not
// by this script: the content root, plus any declared asset mounts. `assetPlan`
// is shared with the content build so that both agree on where the content root
// is. They once disagreed, and pointing Readsmith at a repository (rather than at
// a dedicated content folder) copied that repository's whole source tree here.
//
// public/ is treated as generated (cleared each run). Runs before `dev` and
// `build` via the pnpm pre-hooks.
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { ASSET_SKIP_EXT, ASSET_SKIP_FILES, assetPlan, resolveConfig } from "@readsmith/config";

const ROOT = process.env.READSMITH_CONTENT ?? join(process.cwd(), "content");
const PUBLIC = join(process.cwd(), "public");

/** Sorted, so the same input tree always produces the same output tree. */
async function entriesOf(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

async function walk(dir, destRoot, skipContent) {
  let copied = 0;
  for (const entry of await entriesOf(dir)) {
    if (entry.name.startsWith(".")) continue; // .git, dotfiles
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      copied += await walk(full, join(destRoot, entry.name), skipContent);
      continue;
    }
    // Prose and config are inputs to the build, never served as files. A declared
    // mount is copied whole: the operator asked for it by name.
    if (skipContent && ASSET_SKIP_EXT.has(extname(entry.name).toLowerCase())) continue;
    if (skipContent && ASSET_SKIP_FILES.has(entry.name)) continue;

    const dest = join(destRoot, entry.name);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(full, dest);
    copied += 1;
  }
  return copied;
}

async function main() {
  if (!existsSync(ROOT)) {
    console.warn(`[readsmith] content dir not found, skipping asset copy: ${ROOT}`);
    return;
  }
  const config = await resolveConfig(ROOT);
  for (const d of config.diagnostics) {
    if (d.code === "asset-mount") console.warn(`[readsmith] ${d.severity} ${d.code}: ${d.message}`);
  }

  await rm(PUBLIC, { recursive: true, force: true });
  await mkdir(PUBLIC, { recursive: true });

  let total = 0;
  let mounts = 0;
  for (const entry of assetPlan(ROOT, config)) {
    if (!existsSync(entry.dir)) {
      console.warn(`[readsmith] asset mount not found, skipping: ${relative(ROOT, entry.dir)}`);
      continue;
    }
    total += await walk(entry.dir, join(PUBLIC, entry.prefix), entry.skipContent);
    if (entry.prefix) mounts += 1;
  }
  const suffix = mounts > 0 ? ` (+${mounts} asset mount(s))` : "";
  console.log(`[readsmith] copied ${total} static asset(s) into public/${suffix}`);
}

main().catch((error) => {
  console.warn("[readsmith] asset copy failed:", error.message);
});
