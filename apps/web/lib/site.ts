import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "@readsmith/components";
import { resolveConfig } from "@readsmith/config";
import { type SiteBuild, assembleSite } from "@readsmith/mdx";

/**
 * Server-only. Runs the Readsmith pipeline (resolve config, then P1-P7 assembly)
 * over the content directory and memoizes the result, so `next build` builds the
 * site once and every page and SEO route reads from the same SiteBuild. Next is
 * the serving shell here; the compile happens entirely in these packages.
 *
 * Point it at your docs with READSMITH_CONTENT; defaults to the bundled sample.
 */
const CONTENT_DIR = process.env.READSMITH_CONTENT ?? join(process.cwd(), "content");

export interface Site {
  build: SiteBuild;
  name: string;
  branding: boolean;
  url?: string;
  description?: string;
  logo?: string;
  favicon?: string;
}

let cached: Promise<Site> | null = null;

export function getSite(): Promise<Site> {
  if (!cached) cached = buildSite();
  return cached;
}

async function buildSite(): Promise<Site> {
  const config = await resolveConfig(CONTENT_DIR);
  const contentRoot = join(CONTENT_DIR, config.content.root);
  const build = await assembleSite({
    config,
    readPage: (path) => readFile(join(contentRoot, path), "utf8"),
    registry: createRegistry(),
    baseUrl: config.site.url,
  });

  // Surface the build report (cross-page broken links, etc.) to the terminal.
  const errors = build.diagnostics.filter((d) => d.severity === "error").length;
  const warnings = build.diagnostics.filter((d) => d.severity === "warning").length;
  if (errors > 0 || warnings > 0) {
    console.warn(`[readsmith] build report: ${errors} error(s), ${warnings} warning(s)`);
    for (const d of build.diagnostics.slice(0, 20)) {
      console.warn(`  ${d.severity} ${d.code} (${d.source}): ${d.message}`);
    }
  }

  return {
    build,
    name: config.site.name,
    branding: config.branding,
    url: config.site.url,
    description: config.site.description,
    logo: config.site.logo,
    favicon: config.site.favicon,
  };
}
