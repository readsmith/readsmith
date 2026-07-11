// Publish static assets into public/, and nothing else.
//
// Which files are servable is decided by the config plus the shared walk in
// @readsmith/build (`collectAssets`), so this script and the content build
// always agree on where the content root is and what counts as an asset. They
// once disagreed, and pointing Readsmith at a repository (rather than at a
// dedicated content folder) copied that repository's whole source tree here.
//
// public/ is treated as generated (cleared each run). Runs before `dev` and
// `build` via the pnpm pre-hooks.
import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { collectAssets } from "@readsmith/build";
import { resolveConfig } from "@readsmith/config";

const ROOT = process.env.READSMITH_CONTENT ?? join(process.cwd(), "content");
const PUBLIC = join(process.cwd(), "public");

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

  const { entries, missingMounts, mounts } = await collectAssets(ROOT, config);
  for (const missing of missingMounts) {
    console.warn(`[readsmith] asset mount not found, skipping: ${missing}`);
  }
  for (const entry of entries) {
    const dest = join(PUBLIC, entry.key);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(entry.source, dest);
  }
  const suffix = mounts > 0 ? ` (+${mounts} asset mount(s))` : "";
  console.log(`[readsmith] copied ${entries.length} static asset(s) into public/${suffix}`);
}

main().catch((error) => {
  console.warn("[readsmith] asset copy failed:", error.message);
});
