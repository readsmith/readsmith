import { join } from "node:path";
import type { Diagnostic } from "@readsmith/model";
import { discoverPages } from "./discover.js";
import { defaultSiteName, loadConfig } from "./load.js";
import { buildAutoNav, buildExplicitNav } from "./nav.js";
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE, type ResolvedConfig } from "./schema.js";

/**
 * Resolve a site from a repository root: load and validate the config (or apply
 * defaults when absent), discover content, and build navigation. A repo with
 * only `.mdx` files and no config still resolves to a working site.
 */
export async function resolveConfig(root: string): Promise<ResolvedConfig> {
  const diagnostics: Diagnostic[] = [];

  const loaded = await loadConfig(root);
  diagnostics.push(...loaded.diagnostics);
  const input = loaded.config;

  const contentRel = input?.content?.root ?? ".";
  const contentRoot = join(root, contentRel);
  const include = input?.content?.include ?? DEFAULT_INCLUDE;
  const exclude = input?.content?.exclude ?? DEFAULT_EXCLUDE;

  const pages = await discoverPages(contentRoot, include, exclude);

  let nav: ResolvedConfig["nav"];
  if (input?.navigation) {
    const built = buildExplicitNav(input.navigation, pages);
    nav = built.nav;
    diagnostics.push(...built.diagnostics);
  } else {
    nav = buildAutoNav(pages);
  }

  let tabs: ResolvedConfig["tabs"];
  if (input?.tabs) {
    tabs = input.tabs.map((tab) => {
      const built = buildExplicitNav(tab.pages, pages);
      diagnostics.push(...built.diagnostics);
      return { label: tab.tab, nav: built.nav };
    });
  }

  const apiReference = input?.apiReference
    ? {
        spec: input.apiReference.spec,
        path: input.apiReference.path ?? "/api-reference",
        label: input.apiReference.label ?? "API Reference",
      }
    : undefined;

  return {
    site: {
      name: input?.site.name ?? defaultSiteName(root),
      url: input?.site.url,
      description: input?.site.description,
      logo: input?.site.logo,
      favicon: input?.site.favicon,
      theme: input?.site.theme ?? {},
    },
    content: { root: contentRel, include, exclude },
    variables: input?.variables ?? {},
    pages,
    nav,
    tabs,
    apiReference,
    branding: input?.branding ?? true,
    ai: input?.ai,
    diagnostics,
  };
}
