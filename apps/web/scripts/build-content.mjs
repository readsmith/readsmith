// Precompiles the content into an immutable bundle artifact (.readsmith/bundle.json),
// run as a prebuild step. This is the "compile" layer: the whole pipeline (config
// resolution, the P1-P7 MDX build, and OpenAPI ingest) happens here, once, so the
// Next app is a pure serving shell that just reads the artifact. Keeping the
// filesystem-heavy pipeline out of Next's route graph is what makes the build
// deterministic and the serving layer trivial (and it is what the M3 search
// ingest will read from).
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { normalizeDocument, parseAndBundle } from "@readsmith/api-reference";
import { createRegistry, themeToCss } from "@readsmith/components";
import { contentRootOf, resolveConfig } from "@readsmith/config";
import { assembleSite } from "@readsmith/mdx";
import { contentHash, normalizedSpecSchema } from "@readsmith/model";
import { createBundleStore, resolveStorageConfig } from "@readsmith/storage";

const CONTENT_DIR = process.env.READSMITH_CONTENT ?? join(process.cwd(), "content");
// The compile step writes through the same BundleStore port the serving shell
// reads from. Local FS by default (root apps/web/.readsmith); STORAGE_ROOT can
// repoint it at a mounted volume without touching this script.
const store = createBundleStore(
  resolveStorageConfig(process.env, join(process.cwd(), ".readsmith")),
);
const BUNDLE_KEY = "bundle.json";

async function buildApiReference(config, contentRoot) {
  if (!config.apiReference) return null;
  const source = config.apiReference.spec;
  const specPath = join(contentRoot, source);
  let raw;
  try {
    raw = await readFile(specPath, "utf8");
  } catch {
    console.warn(`[readsmith] api reference: could not read spec at ${source}`);
    return null;
  }
  const parsed = await parseAndBundle({ raw, path: specPath, source });
  if (!parsed.doc) {
    for (const d of parsed.diagnostics) console.warn(`  ${d.severity} ${d.code}: ${d.message}`);
    return null;
  }
  const content = normalizeDocument(parsed.doc, source);
  const hash = contentHash(raw);
  const spec = {
    specId: hash.slice(0, 16),
    siteId: "default",
    version: 1,
    sourceHash: hash,
    info: content.info,
    servers: content.servers,
    securitySchemes: content.securitySchemes,
    tags: content.tags,
    operations: content.operations,
    schemas: content.schemas,
  };
  if (!normalizedSpecSchema.safeParse(spec).success) {
    console.warn("[readsmith] api reference: normalized spec failed validation; skipping.");
    return null;
  }
  const diagnostics = [...parsed.diagnostics, ...content.diagnostics];
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.filter((d) => d.severity === "warning").length;
  console.log(
    `[readsmith] api reference: ${spec.operations.length} operation(s), ${errors} error(s), ${warnings} warning(s)`,
  );
  return {
    spec,
    path: config.apiReference.path,
    label: config.apiReference.label,
    layout: config.apiReference.layout,
  };
}

/**
 * Authored agent skills: `.readsmith/skills/<name>/SKILL.md` (or the
 * `.mintlify/skills/` migration fallback when that is absent), plus a root
 * `skill.md`. Files are read up to one nested level (scripts/, references/,
 * assets/); validation happens in assembly, this just reads text.
 */
async function readSkills(contentRoot) {
  const out = [];
  let root = join(contentRoot, ".readsmith/skills");
  if (!existsSync(root)) {
    const mintlify = join(contentRoot, ".mintlify/skills");
    root = existsSync(mintlify) ? mintlify : null;
  }
  if (root) {
    const dirs = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const dir of dirs) {
      const skillRoot = join(root, dir.name);
      const files = [];
      const entries = (await readdir(skillRoot, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        if (entry.isFile()) {
          files.push({
            path: entry.name,
            content: await readFile(join(skillRoot, entry.name), "utf8"),
          });
        } else if (entry.isDirectory()) {
          const nested = (await readdir(join(skillRoot, entry.name), { withFileTypes: true }))
            .filter((e) => e.isFile())
            .sort((a, b) => a.name.localeCompare(b.name));
          for (const file of nested) {
            files.push({
              path: `${entry.name}/${file.name}`,
              content: await readFile(join(skillRoot, entry.name, file.name), "utf8"),
            });
          }
        }
      }
      out.push({ dir: dir.name, source: relative(contentRoot, skillRoot), files });
    }
  }
  const rootFile = join(contentRoot, "skill.md");
  if (existsSync(rootFile)) {
    out.push({
      dir: null,
      source: "skill.md",
      files: [{ path: "SKILL.md", content: await readFile(rootFile, "utf8") }],
    });
  }
  return out;
}

async function main() {
  const config = await resolveConfig(CONTENT_DIR);
  // Shared with copy-assets: both must resolve the same content root.
  const contentRoot = contentRootOf(CONTENT_DIR, config);
  // The spec normalizes before assembly: hybrid `openapi:` pages bind to its
  // operations during the P7 build.
  const apiReference = await buildApiReference(config, contentRoot);
  const build = await assembleSite({
    config,
    readPage: (path) => readFile(join(contentRoot, path), "utf8"),
    // The spec powers <Operation op="..."/> embeds in any prose page.
    registry: createRegistry({ apiSpec: apiReference?.spec ?? null }),
    baseUrl: config.site.url,
    apiReference: apiReference
      ? {
          spec: apiReference.spec,
          source: config.apiReference.spec,
          path: config.apiReference.path,
          layout: config.apiReference.layout,
          label: config.apiReference.label,
        }
      : null,
    skills: await readSkills(contentRoot),
  });

  // Config diagnostics (reserved paths, asset mounts, home page) matter as much as
  // build ones: a page that collides with a served route breaks that route too.
  for (const d of config.diagnostics) {
    console.warn(`[readsmith] ${d.severity} ${d.code} (${d.source}): ${d.message}`);
  }

  const errors = build.diagnostics.filter((d) => d.severity === "error").length;
  const warnings = build.diagnostics.filter((d) => d.severity === "warning").length;
  if (errors > 0 || warnings > 0) {
    console.warn(`[readsmith] build report: ${errors} error(s), ${warnings} warning(s)`);
    for (const d of build.diagnostics.slice(0, 20)) {
      console.warn(`  ${d.severity} ${d.code} (${d.source}): ${d.message}`);
    }
  }

  const site = {
    build,
    name: config.site.name,
    branding: config.branding,
    url: config.site.url,
    description: config.site.description,
    logo: config.site.logo,
    favicon: config.site.favicon,
    // Precompiled per-site brand theme, injected into <head> by the shell.
    themeCss: themeToCss(config.site.theme),
    appearance: config.appearance,
    apiReference: config.apiReference,
    footer: config.footer,
    ai: config.ai ?? null,
  };

  await store.put(BUNDLE_KEY, JSON.stringify({ site, apiReference }));
  console.log(`[readsmith] wrote content bundle: ${build.pages.length} page(s) -> ${BUNDLE_KEY}`);
}

main().catch((err) => {
  console.error("[readsmith] content build failed:", err);
  process.exit(1);
});
