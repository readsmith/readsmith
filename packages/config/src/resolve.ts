import { existsSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve as resolvePath, sep } from "node:path";
import type { Diagnostic } from "@readsmith/model";
import { analyticsCspSources } from "./analytics.js";
import { discoverPages } from "./discover.js";
import { defaultSiteName, loadConfig } from "./load.js";
import { buildAutoNav, buildExplicitNav } from "./nav.js";
import { reservedPathConflicts } from "./reserved.js";
import {
  ASSET_SKIP_EXT,
  ASSET_SKIP_FILES,
  type AssetMount,
  DEFAULT_EXCLUDE,
  DEFAULT_INCLUDE,
  type PageRef,
  type ResolvedConfig,
  type SiteImage,
  type SiteImageInput,
} from "./schema.js";
import { siteBasePath } from "./url.js";

/**
 * Normalize a brand image (logo, favicon) to a per-theme pair. A bare string
 * serves both themes; a one-sided pair falls back to the present side with a
 * warning (the site renders, but one theme wears the wrong asset until the
 * other lands); an empty object is treated as unset, with a warning.
 */
function resolveSiteImage(
  input: SiteImageInput | undefined,
  name: string,
  diagnostics: Diagnostic[],
  basePath = "",
): SiteImage | undefined {
  // Site-root-relative brand assets carry the base path like every other
  // served path (spec subpath-hosting SP-3, "the icons metadata"); external
  // URLs pass through untouched.
  const prefix = (u: string) => (basePath && u.startsWith("/") ? `${basePath}${u}` : u);
  if (input === undefined) return undefined;
  if (typeof input === "string") return { light: prefix(input), dark: prefix(input) };
  const light = input.light ?? input.dark;
  const dark = input.dark ?? input.light;
  if (light === undefined || dark === undefined) {
    diagnostics.push({
      severity: "warning",
      code: "site-image-empty",
      message: `site.${name} is an empty object; set a URL string or a { light, dark } pair.`,
      source: "docs.yaml",
    });
    return undefined;
  }
  if (input.light === undefined || input.dark === undefined) {
    const missing = input.light === undefined ? "light" : "dark";
    const present = missing === "light" ? "dark" : "light";
    diagnostics.push({
      severity: "warning",
      code: "site-image-variant-missing",
      message: `site.${name} has no ${missing} variant; the ${present} one serves both themes.`,
      source: "docs.yaml",
    });
  }
  return { light: prefix(light), dark: prefix(dark) };
}

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
/** Operator CSP extensions plus whatever the configured analytics providers need. */
function withAnalyticsCsp(
  csp: import("./security.js").CspExtensions,
  analytics: import("./schema.js").AnalyticsConfig | undefined,
): import("./security.js").CspExtensions {
  const extra = analyticsCspSources(analytics);
  if (extra.scriptSrc.length === 0 && extra.connectSrc.length === 0) return csp;
  return {
    ...csp,
    scriptSrc: [...(csp.scriptSrc ?? []), ...extra.scriptSrc],
    connectSrc: [...(csp.connectSrc ?? []), ...extra.connectSrc],
  };
}

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

/**
 * Promote one file to the site's home page (slug ""). The slug rules already map
 * an `index` or `readme` file to its directory; this exists so that file may live
 * above the content root, which is where every repository keeps its README.
 *
 * Its relative links and images are repository-root relative rather than
 * content-root relative. The MDX transform canonicalizes both against the content
 * root, so `docs/cli.md` in a README resolves to the same page as `cli.md` does
 * from inside `docs/`.
 */
function resolveHome(
  root: string,
  contentRoot: string,
  home: string | undefined,
  pages: PageRef[],
  diagnostics: Diagnostic[],
): PageRef[] {
  if (!home) return pages;

  if (!/\.(md|mdx)$/i.test(home)) {
    diagnostics.push({
      severity: "error",
      code: "content-home",
      message: `content.home must be a Markdown file, got "${home}".`,
      source: "docs.yaml",
    });
    return pages;
  }

  const abs = resolvePath(contentRoot, home);
  if (!isInside(root, abs)) {
    diagnostics.push({
      severity: "error",
      code: "content-home",
      message: `content.home "${home}" escapes the repository root and was ignored.`,
      source: "docs.yaml",
    });
    return pages;
  }
  if (!existsSync(abs)) {
    diagnostics.push({
      severity: "warning",
      code: "content-home",
      message: `content.home "${home}" does not exist and was ignored.`,
      source: "docs.yaml",
    });
    return pages;
  }

  const path = normalizeFrom(home);
  const existing = pages.find((p) => p.slug === "");
  if (existing?.path === path) return pages; // already discovered, nothing to do
  if (existing) {
    diagnostics.push({
      severity: "warning",
      code: "content-home",
      message: `content.home "${path}" replaces "${existing.path}" as the site root.`,
      source: "docs.yaml",
    });
  }
  return [{ path, slug: "" }, ...pages.filter((p) => p.slug !== "")];
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

  const discovered = await discoverPages(contentRoot, include, exclude);
  const pages = resolveHome(root, contentRoot, input?.content?.home, discovered, diagnostics);
  // A page that lands on a path the app serves is unreachable, and in Next the
  // collision breaks the route it shadows too. Say so at build time.
  diagnostics.push(...reservedPathConflicts(pages));
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
      const built = buildExplicitNav(tab.pages ?? [], pages);
      diagnostics.push(...built.diagnostics);
      const menu = tab.menu?.map((item) => {
        const itemNav = buildExplicitNav(item.pages, pages);
        diagnostics.push(...itemNav.diagnostics);
        return { label: item.item, nav: itemNav.nav, ...(item.icon ? { icon: item.icon } : {}) };
      });
      return {
        label: tab.tab,
        nav: built.nav,
        ...(tab.icon ? { icon: tab.icon } : {}),
        ...(menu && menu.length > 0 ? { menu } : {}),
      };
    });
  }

  const apiReference = input?.apiReference
    ? {
        spec: input.apiReference.spec,
        path: input.apiReference.path ?? "/api-reference",
        label: input.apiReference.label ?? "API Reference",
        layout: input.apiReference.layout ?? "single",
      }
    : undefined;

  return {
    site: {
      name: input?.site.name ?? defaultSiteName(root),
      url: input?.site.url,
      description: input?.site.description,
      homeUrl: input?.site.homeUrl,
      logo: resolveSiteImage(input?.site.logo, "logo", diagnostics, siteBasePath(input?.site.url)),
      favicon: resolveSiteImage(
        input?.site.favicon,
        "favicon",
        diagnostics,
        siteBasePath(input?.site.url),
      ),
      author: input?.site.author,
      publisher: input?.site.publisher,
      theme: input?.site.theme ?? {},
    },
    appearance: { default: input?.appearance?.default ?? "system" },
    security: { csp: withAnalyticsCsp(input?.security?.csp ?? {}, input?.analytics) },
    analytics: input?.analytics,
    content: { root: contentRel, include, exclude, home: input?.content?.home },
    assets,
    links: {
      repo: input?.links?.repo?.replace(/\/+$/, ""),
      branch: input?.links?.branch ?? "main",
    },
    mcp: { path: input?.mcp?.path },
    variables: input?.variables ?? {},
    pages,
    nav,
    tabs,
    apiReference,
    footer: input?.footer,
    branding: input?.branding ?? true,
    ai: input?.ai,
    diagnostics,
  };
}

export { ASSET_SKIP_EXT, ASSET_SKIP_FILES };
