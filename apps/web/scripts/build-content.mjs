// Precompiles the content into an immutable bundle artifact (.readsmith/bundle.json),
// run as a prebuild step. The compile itself lives in @readsmith/build (one
// deterministic path, shared with any other caller that turns content into a
// bundle); this script is the local caller: compile, report diagnostics, and
// write the bytes through the same BundleStore port the serving shell reads.
// Keeping the filesystem-heavy pipeline out of Next's route graph is what makes
// the build deterministic and the serving layer trivial.
import { join } from "node:path";
import { compileSite } from "@readsmith/build";
import { createBundleStore, resolveStorageConfig } from "@readsmith/storage";

const CONTENT_DIR = process.env.READSMITH_CONTENT ?? join(process.cwd(), "content");
// The compile step writes through the same BundleStore port the serving shell
// reads from. Local FS by default (root apps/web/.readsmith); STORAGE_ROOT can
// repoint it at a mounted volume without touching this script.
const store = createBundleStore(
  resolveStorageConfig(process.env, join(process.cwd(), ".readsmith")),
);
const BUNDLE_KEY = "bundle.json";

async function main() {
  const { config, bundle, bundleJson, apiReferenceDiagnostics } = await compileSite({
    contentDir: CONTENT_DIR,
  });

  // Config diagnostics (reserved paths, asset mounts, home page) matter as much as
  // build ones: a page that collides with a served route breaks that route too.
  for (const d of config.diagnostics) {
    console.warn(`[readsmith] ${d.severity} ${d.code} (${d.source}): ${d.message}`);
  }

  if (config.apiReference) {
    if (bundle.apiReference) {
      const errors = apiReferenceDiagnostics.filter((d) => d.severity === "error").length;
      const warnings = apiReferenceDiagnostics.filter((d) => d.severity === "warning").length;
      console.log(
        `[readsmith] api reference: ${bundle.apiReference.spec.operations.length} operation(s), ${errors} error(s), ${warnings} warning(s)`,
      );
    } else {
      console.warn("[readsmith] api reference: spec did not load");
      for (const d of apiReferenceDiagnostics) {
        console.warn(`  ${d.severity} ${d.code}: ${d.message}`);
      }
    }
  }

  const build = bundle.site.build;
  const errors = build.diagnostics.filter((d) => d.severity === "error").length;
  const warnings = build.diagnostics.filter((d) => d.severity === "warning").length;
  if (errors > 0 || warnings > 0) {
    console.warn(`[readsmith] build report: ${errors} error(s), ${warnings} warning(s)`);
    for (const d of build.diagnostics.slice(0, 20)) {
      console.warn(`  ${d.severity} ${d.code} (${d.source}): ${d.message}`);
    }
  }

  await store.put(BUNDLE_KEY, bundleJson);
  console.log(`[readsmith] wrote content bundle: ${build.pages.length} page(s) -> ${BUNDLE_KEY}`);
}

main().catch((err) => {
  console.error("[readsmith] content build failed:", err);
  process.exit(1);
});
