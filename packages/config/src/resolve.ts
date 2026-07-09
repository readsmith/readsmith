import { isAbsolute, join, posix, relative, resolve as resolvePath, sep } from "node:path";
import type { Diagnostic } from "@readsmith/model";
import { discoverPages } from "./discover.js";
import { defaultSiteName, loadConfig } from "./load.js";
import { buildAutoNav, buildExplicitNav } from "./nav.js";
import {
  ASSET_SKIP_EXT,
  ASSET_SKIP_FILES,
  type AssetMount,
  DEFAULT_EXCLUDE,
  DEFAULT_INCLUDE,
  type ResolvedConfig,
} from "./schema.js";

/**
 * Resolve a site from a repository root: load and validate the config (or apply
 * defaults when absent), discover content, and build navigation. A repo with
 * only `.mdx` files and no config still resolves to a working site.
 */

/**
 * The one place the content root is computed. Both the content build and the
 * asset copy must agree on it: when they disagreed, pointing Readsmith at a
 * repository published that repository's source tree.
 */
export function contentRootOf(root: string, config: { content: { root: string } }): string {
  return join(root, config.content.root);
}

/** A directory to publish, and the URL prefix it is served under. */
export interface AssetPlanEntry {
  /** Absolute source directory. */
  dir: string;
  /** URL path prefix, "" for the content root itself. */
  prefix: string;
  /** Skip Markdown and config files (true for the content root, which is prose). */
  skipContent: boolean;
}

/**
 * Every directory whose files may be served, and nothing else. The content root
 * comes first; declared mounts follow. A file that lives under none of these is
 * never copied, which is what keeps `internal/**\/*.go` out of `public/`.
 */
export function assetPlan(root: string, config: ResolvedConfig): AssetPlanEntry[] {
  const contentRoot = contentRootOf(root, config);
  return [
    { dir: contentRoot, prefix: "", skipContent: true },
    ...config.assets.map((mount) => ({
      dir: resolvePath(contentRoot, mount.from),
      prefix: mount.to,
      skipContent: false,
    })),
  ];
}

/** True when `child` is strictly inside `parent` (not equal to it, not above it). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Normalize `from` to a POSIX, content-root-relative key the MDX transform matches. */
function normalizeFrom(from: string): string {
  const posixed = from.split(sep).join("/");
  return posix.normalize(posixed).replace(/\/+$/, "");
}

function resolveAssets(
  root: string,
  contentRoot: string,
  mounts: AssetMount[] | undefined,
  diagnostics: Diagnostic[],
): AssetMount[] {
  const out: AssetMount[] = [];
  for (const mount of mounts ?? []) {
    const to = mount.to.replace(/^\/+|\/+$/g, "");
    if (!to || to.split("/").includes("..")) {
      diagnostics.push({
        severity: "error",
        code: "asset-mount",
        message: `Asset mount "to" must be a simple path, got "${mount.to}".`,
        source: "docs.yaml",
      });
      continue;
    }

    // Escaping the content root is the point. Escaping the repository is not:
    // that would publish whatever sits beside the checkout.
    const dir = resolvePath(contentRoot, mount.from);
    if (!isInside(root, dir)) {
      diagnostics.push({
        severity: "error",
        code: "asset-mount",
        message: `Asset mount "${mount.from}" escapes the repository root and was ignored.`,
        source: "docs.yaml",
      });
      continue;
    }

    out.push({ from: normalizeFrom(mount.from), to });
  }
  return out;
}

export async function resolveConfig(root: string): Promise<ResolvedConfig> {
  const diagnostics: Diagnostic[] = [];

  const loaded = await loadConfig(root);
  diagnostics.push(...loaded.diagnostics);
  const input = loaded.config;

  const contentRel = input?.content?.root ?? ".";
  const contentRoot = join(root, contentRel);
  const include = input?.content?.include ?? DEFAULT_INCLUDE;
  // Merged, not replaced: a user's exclude adds to the defaults.
  const exclude = [...DEFAULT_EXCLUDE, ...(input?.content?.exclude ?? [])];

  const pages = await discoverPages(contentRoot, include, exclude);
  const assets = resolveAssets(root, contentRoot, input?.assets, diagnostics);

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
    assets,
    links: {
      repo: input?.links?.repo?.replace(/\/+$/, ""),
      branch: input?.links?.branch ?? "main",
    },
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

export { ASSET_SKIP_EXT, ASSET_SKIP_FILES };
