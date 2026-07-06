// Copy static assets (images, and any non-Markdown file) from the content
// directory into public/, preserving structure, so a docs repo's local images
// resolve instead of 404ing. Runs before `dev` and `build` (pnpm pre-hooks).
//
// public/ is treated as generated here (cleared each run). Full content-relative
// asset URL rewriting (P2 FR-4) is still a follow-up; this handles absolute paths
// and images co-located with their page.
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";

const CONTENT = process.env.READSMITH_CONTENT ?? join(process.cwd(), "content");
const PUBLIC = join(process.cwd(), "public");
const SKIP_EXT = new Set([".md", ".mdx"]);
const SKIP_FILES = new Set(["docs.yaml", "docs.yml", "docs.json"]);

async function walk(dir) {
  let copied = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // .git, dotfiles
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      copied += await walk(full);
      continue;
    }
    if (SKIP_EXT.has(extname(entry.name).toLowerCase())) continue;
    if (SKIP_FILES.has(entry.name)) continue;
    const dest = join(PUBLIC, relative(CONTENT, full));
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(full, dest);
    copied += 1;
  }
  return copied;
}

async function main() {
  if (!existsSync(CONTENT)) {
    console.warn(`[readsmith] content dir not found, skipping asset copy: ${CONTENT}`);
    return;
  }
  await rm(PUBLIC, { recursive: true, force: true });
  await mkdir(PUBLIC, { recursive: true });
  const count = await walk(CONTENT);
  console.log(`[readsmith] copied ${count} static asset(s) into public/`);
}

main().catch((error) => {
  console.warn("[readsmith] asset copy failed:", error.message);
});
