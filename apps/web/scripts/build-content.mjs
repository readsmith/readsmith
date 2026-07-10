// Precompiles the content into an immutable bundle artifact (.readsmith/bundle.json),
// run as a prebuild step. This is the "compile" layer: the whole pipeline (config
// resolution, the P1-P7 MDX build, and OpenAPI ingest) happens here, once, so the
// Next app is a pure serving shell that just reads the artifact. Keeping the
// filesystem-heavy pipeline out of Next's route graph is what makes the build
// deterministic and the serving layer trivial (and it is what the M3 search
// ingest will read from).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
  return { spec, path: config.apiReference.path, label: config.apiReference.label };
}

async function main() {
  const config = await resolveConfig(CONTENT_DIR);
  // Shared with copy-assets: both must resolve the same content root.
  const contentRoot = contentRootOf(CONTENT_DIR, config);
  const build = await assembleSite({
    config,
    readPage: (path) => readFile(join(contentRoot, path), "utf8"),
    registry: createRegistry(),
    baseUrl: config.site.url,
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
    apiReference: config.apiReference,
    footer: config.footer,
    ai: config.ai ?? null,
  };
  const apiReference = await buildApiReference(config, contentRoot);

  await store.put(BUNDLE_KEY, JSON.stringify({ site, apiReference }));
  console.log(`[readsmith] wrote content bundle: ${build.pages.length} page(s) -> ${BUNDLE_KEY}`);
}

main().catch((err) => {
  console.error("[readsmith] content build failed:", err);
  process.exit(1);
});
