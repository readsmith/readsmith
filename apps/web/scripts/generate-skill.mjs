// The offline skill generator command (spec agent-skills SK-30/SK-34/SK-37):
// reads the BUILT bundle, runs the bounded map/reduce/verify loop on the
// operator's own key, and writes `.readsmith/skills/<name>/SKILL.md` into the
// content repo for review and commit. This is NEVER invoked by predev/prebuild;
// the build path stays AI-free and deterministic.
//
// Usage: pnpm skill:generate [--dry-run] [--force] [--model <id>]
//   --dry-run     print the generated document and cost summary, write nothing
//   --force       overwrite a hand-authored skill (one missing the generated
//                 marker) or regenerate despite an unchanged content hash
//   --model <id>  generate with this chat model instead of the site's ai.chat
//                 model (same provider and key). The runtime Ask-AI model is
//                 usually picked for speed and cost; generation runs rarely and
//                 rewards the strongest model available.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelProvider, envKeySource, generateSkill, resolveAiConfig } from "@readsmith/ai";
import { contentRootOf, resolveConfig } from "@readsmith/config";
import { skillNameOf } from "@readsmith/mdx";
import { contentHash } from "@readsmith/model";
import { createBundleStore, resolveStorageConfig } from "@readsmith/storage";

const CONTENT_DIR = process.env.READSMITH_CONTENT ?? join(process.cwd(), "content");
const BUNDLE_KEY = "bundle.json";
const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const MODEL_FLAG = process.argv.indexOf("--model");
const MODEL = MODEL_FLAG >= 0 ? process.argv[MODEL_FLAG + 1] : undefined;

function fail(message) {
  console.error(`[readsmith] ${message}`);
  process.exit(1);
}

/** The generated marker, or null for a hand-authored file. */
function generatedMarker(content) {
  const match = /^\s*readsmith-generated:\s*"?([^"\n]+)"?\s*$/m.exec(content);
  return match ? match[1].trim() : null;
}

function printDiff(oldPath, newContent, label) {
  // Two real files: piping to `diff old /dev/stdin` breaks under sandboxed
  // stdio (exit 2, "No such device or address"), which read as "no change".
  const dir = mkdtempSync(join(tmpdir(), "readsmith-skill-"));
  try {
    const newPath = join(dir, "SKILL.md");
    writeFileSync(newPath, newContent, "utf8");
    const result = spawnSync(
      "diff",
      [
        "-u",
        "--label",
        `${label} (committed)`,
        "--label",
        `${label} (regenerated)`,
        oldPath,
        newPath,
      ],
      { encoding: "utf8" },
    );
    // diff: 0 = same, 1 = differ, 2 = trouble.
    if (result.error || result.status === 2) {
      console.log("[readsmith] (diff unavailable; file overwritten)");
      return;
    }
    console.log(result.stdout.trimEnd() || "[readsmith] no textual change");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const store = createBundleStore(
    resolveStorageConfig(process.env, join(process.cwd(), ".readsmith")),
  );
  const raw = await store.get(BUNDLE_KEY).catch(() => null);
  if (!raw) fail("no content bundle found; run the build first (pnpm build-content or dev).");
  const { site } = JSON.parse(raw);
  const build = site.build;

  // The generator summarizes exactly what the site serves: visible pages only,
  // no hidden pages and no pages-mode mirrors.
  const pages = build.pages
    .filter((p) => !p.hidden && !p.canonicalOf)
    .map((p) => ({ url: p.url, title: p.title, description: p.description, rawMd: p.rawMd }));
  const input = {
    site: { name: site.name, description: site.description, url: site.url },
    pages,
    name: skillNameOf(site.name),
    inputHash: contentHash({
      site: { name: site.name, description: site.description, url: site.url },
      pages: pages.map((p) => ({ url: p.url, rawMd: p.rawMd })),
    }),
  };

  // Write target inside the CONTENT repo, where the next build picks it up as
  // an ordinary authored skill.
  const config = await resolveConfig(CONTENT_DIR);
  const contentRoot = contentRootOf(CONTENT_DIR, config);
  const targetDir = join(contentRoot, ".readsmith/skills", input.name);
  const target = join(targetDir, "SKILL.md");

  const existing = existsSync(target) ? await readFile(target, "utf8") : null;
  const marker = existing ? generatedMarker(existing) : null;
  if (existing && !marker && !FORCE) {
    fail(
      `${target} exists without a readsmith-generated marker (hand-authored). Refusing to overwrite; pass --force to replace it.`,
    );
  }
  if (existing && marker === input.inputHash && !FORCE && !DRY_RUN) {
    console.log("[readsmith] skill is up to date (content unchanged since last generation).");
    return;
  }

  const resolved = resolveAiConfig(site.ai ?? null);
  if (!resolved?.chat) {
    fail(
      "no chat model configured. Add `ai.chat` (provider + model) to docs.yaml; the key comes from the environment (READSMITH_AI_CHAT_KEY or the provider-native variable).",
    );
  }
  const aiConfig = MODEL ? { ...resolved, chat: { ...resolved.chat, model: MODEL } } : resolved;
  const provider = createModelProvider(aiConfig, envKeySource());
  if (!provider.hasChat()) {
    fail(
      `no API key for the "${aiConfig.chat.provider}" chat provider. Set READSMITH_AI_CHAT_KEY or the provider-native variable (OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / AI_GATEWAY_API_KEY). Nothing was written.`,
    );
  }

  console.log(
    `[readsmith] generating skill "${input.name}" from ${pages.length} page(s) with ${aiConfig.chat.provider}/${aiConfig.chat.model}`,
  );
  let result;
  try {
    result = await generateSkill(input, provider, {
      logger: { info: (m) => console.log(`[readsmith] ${m}`) },
    });
  } catch (err) {
    // The failing draft goes to stderr for diagnosis; it is never written.
    if (err?.draft) console.error(`\n--- failing draft ---\n${err.draft}\n--- end draft ---\n`);
    fail(err instanceof Error ? err.message : String(err));
  }

  const summary = `${result.calls} model call(s), ~${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens${result.repaired ? ", 1 repair round" : ""}`;
  if (DRY_RUN) {
    console.log(`\n${result.content}`);
    console.log(`[readsmith] dry run: nothing written. ${summary}`);
    return;
  }

  await mkdir(targetDir, { recursive: true });
  if (existing) printDiff(target, result.content, target);
  await writeFile(target, result.content, "utf8");
  console.log(`[readsmith] wrote ${target} (${summary})`);
  console.log(
    "[readsmith] review the file, commit it, and rebuild; it then serves as an ordinary authored skill.",
  );
}

main().catch((err) => {
  console.error("[readsmith] skill generation failed:", err);
  process.exit(1);
});
