import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "@readsmith/components";
import { resolveConfig } from "@readsmith/config";
import { type SiteBuild, assembleSite } from "@readsmith/mdx";

/**
 * Server-only. Runs the Readsmith pipeline (resolve config, then P1-P7 assembly)
 * over the content directory and memoizes the result, so `next build` builds the
 * site once and every page reads from the same SiteBuild. Next is the serving
 * shell here; the compile happens entirely in these packages.
 *
 * Point it at your docs with READSMITH_CONTENT; defaults to the bundled sample.
 */
const CONTENT_DIR = process.env.READSMITH_CONTENT ?? join(process.cwd(), "content");

export interface Site {
  build: SiteBuild;
  name: string;
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
  });
  return { build, name: config.site.name };
}
