import { type Diagnostic, contentHash } from "@readsmith/model";
import type { Root } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";
import { parse } from "./parse.js";
import { type Chunk, type TocNode, project } from "./projections.js";
import {
  type ComponentRegistry,
  type IslandManifest,
  type RenderCache,
  type RenderResult,
  render,
} from "./render.js";
import { expandSnippetsAndVariables } from "./snippets.js";
import { transform } from "./transform.js";

/**
 * P7 Assembly: the orchestrator. Runs every page through P1-P6 (rendering is
 * cached and dependency-aware), then does the site-level work that needs all
 * pages at once (nav finalization, cross-page link validation, sitemap, RSS,
 * agent-readiness outputs, search handoff) and assembles a deterministic build.
 *
 * Kept structurally decoupled from `@readsmith/config`: it accepts the resolved
 * config's shape, so a caller passes a ResolvedConfig directly without this
 * package importing that one (mirrors the `resolvePage` callback in P2).
 */

/** A resolved navigation node (matches the config package's output shape). */
export type NavNode =
  | { type: "page"; slug: string }
  | { type: "group"; label: string; children: NavNode[] };

export interface SitePage {
  /** Path relative to the content root, POSIX separators. */
  path: string;
  /** URL slug; the root index page has slug "". */
  slug: string;
}

/** A top-level navigation tab as consumed by assembly: a label and its nav subtree. */
export interface NavTab {
  label: string;
  nav: NavNode[];
}

/** The subset of a resolved config that assembly consumes. */
export interface SiteConfig {
  site: { name: string; url?: string; description?: string; theme?: Record<string, unknown> };
  variables?: Record<string, unknown>;
  pages: SitePage[];
  nav: NavNode[];
  /** Top-level tabs, when configured. Each scopes its own sidebar navigation. */
  tabs?: NavTab[];
}

export interface AssembleInput {
  config: SiteConfig;
  /** Read a content file by its config-relative path. */
  readPage: (path: string) => string | Promise<string>;
  registry: ComponentRegistry;
  /** Snippet name (the `<Snippet file>` value) to its raw source. */
  snippets?: Record<string, string>;
  trust?: "owner" | "contributor" | "preview";
  themes?: { light: string; dark: string };
  /** Reused across builds for incremental, dependency-aware rendering. */
  renderCache?: RenderCache;
  /** Fail the build when any page produces an error diagnostic. */
  failOnError?: boolean;
  /** Participates in every page's cache key so a library bump invalidates all. */
  libVersion?: string;
  /** Canonical base URL for absolute links in sitemap, RSS, and agent outputs.
   * Falls back to `config.site.url`. Without either, URLs stay root-relative. */
  baseUrl?: string;
}

export interface Breadcrumb {
  label: string;
  url?: string;
}

export interface NavLink {
  slug: string;
  url: string;
  title: string;
}

export interface PageModel {
  path: string;
  slug: string;
  url: string;
  title: string;
  description?: string;
  frontmatter: Record<string, unknown>;
  hidden: boolean;
  html: string;
  toc: TocNode[];
  rawMd: string;
  chunks: Chunk[];
  anchors: string[];
  islands: IslandManifest;
  breadcrumbs: Breadcrumb[];
  prev?: NavLink;
  next?: NavLink;
  diagnostics: Diagnostic[];
}

export type FinalNavNode =
  | { type: "page"; slug: string; url: string; title: string }
  | { type: "group"; label: string; children: FinalNavNode[] };

/** A finalized top-level tab: label, landing URL (first page), and its nav tree. */
export interface FinalNavTab {
  label: string;
  url: string;
  nav: FinalNavNode[];
}

export interface SiteBuild {
  pages: PageModel[];
  nav: FinalNavNode[];
  /** Finalized top-level tabs, when configured. Absent for single-nav sites. */
  tabs?: FinalNavTab[];
  sitemap: string;
  rss: string;
  llmsTxt: string;
  llmsFullTxt: string;
  skillMd: string;
  searchChunks: Chunk[];
  diagnostics: Diagnostic[];
  /** Stable hash of the whole build; identical inputs yield an identical hash. */
  bundleHash: string;
  /** False when `failOnError` is set and any error diagnostic was produced. */
  ok: boolean;
  /** Page paths re-rendered this build (a cache miss); the rest were cache hits. */
  rebuilt: string[];
}

/** Run the full site build: per-page pipeline, then site-level assembly. */
export async function assembleSite(input: AssembleInput): Promise<SiteBuild> {
  const { config } = input;
  const trust = input.trust ?? "owner";
  const resolvePage = makeResolvePage(config.pages);

  const built = await Promise.all(
    config.pages.map((page) => buildPage(page, input, trust, resolvePage)),
  );

  const models = built.map((b) => b.model);
  const rebuilt = built.filter((b) => b.rebuilt).map((b) => b.model.path);

  // Cross-page link + anchor validation, now that every page's anchors are known.
  const anchorsBySlug = new Map(models.map((m) => [m.slug, new Set(m.anchors)]));
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const links = built[i]?.links ?? [];
    if (model) validateLinks(model, links, anchorsBySlug);
  }

  // Nav finalization needs titles and hidden flags from the built pages.
  const bySlug = new Map(models.map((m) => [m.slug, m]));
  const nav = finalizeNav(config.nav, bySlug);
  let tabs: FinalNavTab[] | undefined;
  if (config.tabs && config.tabs.length > 0) {
    // Each page belongs to exactly one tab; compute prev/next/breadcrumbs within it.
    tabs = config.tabs.map((tab) => {
      const tabNav = finalizeNav(tab.nav, bySlug);
      applyNavRelations(tabNav, bySlug);
      return { label: tab.label, url: firstPageUrl(tabNav) ?? "/", nav: tabNav };
    });
  } else {
    applyNavRelations(nav, bySlug);
  }

  const visible = models.filter((m) => !m.hidden);
  const base = (input.baseUrl ?? config.site.url ?? "").replace(/\/+$/, "");
  const sitemap = buildSitemap(visible, base);
  const rss = buildRss(config, visible, base);
  const llmsTxt = buildLlmsTxt(config, visible, base);
  const llmsFullTxt = buildLlmsFullTxt(config, visible, base);
  const skillMd = buildSkillMd(config, visible, base);
  const searchChunks = visible.flatMap((m) => m.chunks);

  const diagnostics = models.flatMap((m) => m.diagnostics);
  const ok = !(input.failOnError && diagnostics.some((d) => d.severity === "error"));

  const bundleHash = contentHash({
    site: config.site.name,
    pages: [...models]
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map((m) => ({ slug: m.slug, title: m.title, html: m.html, hidden: m.hidden })),
    nav,
    tabs: tabs ?? null,
    sitemap,
    rss,
    llmsTxt,
    llmsFullTxt,
    skillMd,
  });

  return {
    pages: models,
    nav,
    tabs,
    sitemap,
    rss,
    llmsTxt,
    llmsFullTxt,
    skillMd,
    searchChunks,
    diagnostics,
    bundleHash,
    ok,
    rebuilt,
  };
}

interface InternalLink {
  url: string;
  pos?: { line: number; col: number };
}

interface BuiltPage {
  model: PageModel;
  links: InternalLink[];
  rebuilt: boolean;
}

async function buildPage(
  page: SitePage,
  input: AssembleInput,
  trust: "owner" | "contributor" | "preview",
  resolvePage: (targetPathNoExt: string) => string | null,
): Promise<BuiltPage> {
  const { config } = input;
  const globals = config.variables ?? {};

  let raw: string;
  try {
    raw = await input.readPage(page.path);
  } catch (err) {
    return errorPage(page, `Could not read page: ${(err as Error).message}`);
  }

  const parsed = parse({ path: page.path, raw });
  const frontmatter = parsed.frontmatter;

  const usedSnippets = new Map<string, string>();
  const expanded = expandSnippetsAndVariables(parsed.body, {
    path: page.path,
    global: globals,
    page: frontmatter,
    resolveSnippet: makeSnippetResolver(input.snippets ?? {}, usedSnippets),
  });

  const transformed = transform(expanded.body, { path: page.path, resolvePage });
  const projections = project(transformed.body, { path: page.path });
  const anchors = collectAnchors(transformed.body);
  const links = collectLinks(transformed.body);

  const hidden = frontmatter.hidden === true;
  const title = pickTitle(frontmatter, transformed.body, page.slug, config.site.name);
  const description =
    typeof frontmatter.description === "string" ? frontmatter.description : undefined;

  const cacheKey = contentHash({
    lib: input.libVersion ?? "0",
    trust,
    theme: config.site.theme ?? {},
    path: page.path,
    source: raw,
    globals,
    frontmatter,
    snippets: [...usedSnippets].sort(([a], [b]) => a.localeCompare(b)),
  });

  let renderResult: RenderResult;
  let rebuilt = false;
  const cached = input.renderCache?.get(cacheKey);
  if (cached) {
    renderResult = cached;
  } else {
    renderResult = await render(transformed.body, {
      path: page.path,
      trust,
      scope: { ...globals, ...frontmatter },
      registry: input.registry,
      themes: input.themes,
    });
    input.renderCache?.set(cacheKey, renderResult);
    rebuilt = true;
  }

  const model: PageModel = {
    path: page.path,
    slug: page.slug,
    url: slugToUrl(page.slug),
    title,
    description,
    frontmatter,
    hidden,
    html: renderResult.html,
    toc: projections.toc,
    rawMd: projections.rawMd,
    chunks: projections.chunks,
    anchors,
    islands: renderResult.hydration,
    breadcrumbs: [],
    diagnostics: [
      ...parsed.diagnostics,
      ...expanded.diagnostics,
      ...transformed.diagnostics,
      ...renderResult.diagnostics,
    ],
  };

  return { model, links, rebuilt };
}

function errorPage(page: SitePage, message: string): BuiltPage {
  return {
    model: {
      path: page.path,
      slug: page.slug,
      url: slugToUrl(page.slug),
      title: page.slug || "Untitled",
      frontmatter: {},
      hidden: false,
      html: "",
      toc: [],
      rawMd: "",
      chunks: [],
      anchors: [],
      islands: { islands: [] },
      breadcrumbs: [],
      diagnostics: [{ severity: "error", code: "page-build-error", message, source: page.path }],
    },
    links: [],
    rebuilt: true,
  };
}

/** Resolve a content-relative path (without extension) to a slug, or null. */
function makeResolvePage(pages: SitePage[]): (targetPathNoExt: string) => string | null {
  const map = new Map<string, string>();
  for (const p of pages) {
    map.set(p.path.replace(/\.(md|mdx)$/i, ""), p.slug);
  }
  return (target) => map.get(target) ?? null;
}

/** A snippet resolver over an in-memory source map that records dependency hashes. */
function makeSnippetResolver(
  snippets: Record<string, string>,
  used: Map<string, string>,
): (name: string) => Root | null {
  return (name) => {
    const source = snippets[name];
    if (source === undefined) return null;
    used.set(name, contentHash(source));
    const kind = name.toLowerCase().endsWith(".mdx") ? "mdx" : "md";
    return parse({ path: name, raw: source, kind }).body;
  };
}

function collectAnchors(body: Root): string[] {
  const anchors: string[] = [];
  visit(body, "heading", (node) => {
    const id = (node.data as { id?: unknown } | undefined)?.id;
    if (typeof id === "string" && id) anchors.push(id);
  });
  return anchors;
}

function collectLinks(body: Root): InternalLink[] {
  const links: InternalLink[] = [];
  visit(body, "link", (node) => {
    const start = node.position?.start;
    links.push({
      url: node.url,
      pos: start ? { line: start.line, col: start.column } : undefined,
    });
  });
  return links;
}

/**
 * Validate a page's internal links against the full slug and anchor set. A link
 * to a missing page or a missing anchor is reported; external and resolved
 * links are left alone. Relative-link resolution already happened in P2.
 */
function validateLinks(
  model: PageModel,
  links: InternalLink[],
  anchorsBySlug: Map<string, Set<string>>,
): void {
  for (const link of links) {
    const url = link.url;
    let targetSlug: string | null = null;
    let anchor = "";

    if (url.startsWith("#")) {
      targetSlug = model.slug;
      anchor = url.slice(1);
    } else if (url.startsWith("/")) {
      const hash = url.indexOf("#");
      const pathPart = hash === -1 ? url : url.slice(0, hash);
      anchor = hash === -1 ? "" : url.slice(hash + 1);
      targetSlug = pathPart === "/" ? "" : pathPart.slice(1);
    } else {
      continue; // external, mailto, or already-diagnosed relative link
    }

    const targetAnchors = anchorsBySlug.get(targetSlug);
    if (!targetAnchors) {
      model.diagnostics.push({
        severity: "warning",
        code: "broken-link",
        message: `Link "${url}" points to a page that does not exist.`,
        pos: link.pos,
        source: model.path,
      });
      continue;
    }
    if (anchor && !targetAnchors.has(anchor)) {
      model.diagnostics.push({
        severity: "warning",
        code: "broken-anchor",
        message: `Link "${url}" points to an anchor that does not exist.`,
        pos: link.pos,
        source: model.path,
      });
    }
  }
}

/** Attach titles and drop hidden pages and empty groups from the nav tree. */
function finalizeNav(nav: NavNode[], bySlug: Map<string, PageModel>): FinalNavNode[] {
  const out: FinalNavNode[] = [];
  for (const node of nav) {
    if (node.type === "page") {
      const model = bySlug.get(node.slug);
      if (!model || model.hidden) continue;
      out.push({ type: "page", slug: model.slug, url: model.url, title: model.title });
    } else {
      const children = finalizeNav(node.children, bySlug);
      if (children.length > 0) out.push({ type: "group", label: node.label, children });
    }
  }
  return out;
}

/** The URL of the first page in a finalized nav tree (a tab's landing target). */
function firstPageUrl(nav: FinalNavNode[]): string | undefined {
  for (const node of nav) {
    if (node.type === "page") return node.url;
    const nested = firstPageUrl(node.children);
    if (nested) return nested;
  }
  return undefined;
}

/** Compute prev/next and breadcrumbs from the finalized nav order. */
function applyNavRelations(nav: FinalNavNode[], bySlug: Map<string, PageModel>): void {
  const order: { slug: string; trail: Breadcrumb[] }[] = [];
  const walk = (nodes: FinalNavNode[], trail: Breadcrumb[]): void => {
    for (const node of nodes) {
      if (node.type === "page") {
        order.push({
          slug: node.slug,
          trail: [...trail, { label: node.title, url: node.url }],
        });
      } else {
        walk(node.children, [...trail, { label: node.label }]);
      }
    }
  };
  walk(nav, []);

  for (let i = 0; i < order.length; i++) {
    const entry = order[i];
    if (!entry) continue;
    const model = bySlug.get(entry.slug);
    if (!model) continue;
    model.breadcrumbs = entry.trail;
    const prev = order[i - 1];
    const next = order[i + 1];
    if (prev) model.prev = navLink(bySlug.get(prev.slug));
    if (next) model.next = navLink(bySlug.get(next.slug));
  }
}

function navLink(model: PageModel | undefined): NavLink | undefined {
  if (!model) return undefined;
  return { slug: model.slug, url: model.url, title: model.title };
}

/** Prepend the canonical base to a root-relative URL, when a base is configured. */
function absUrl(base: string, url: string): string {
  return base ? base + url : url;
}

function buildSitemap(pages: PageModel[], base: string): string {
  const urls = [...pages]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((p) => {
      const date = typeof p.frontmatter.date === "string" ? p.frontmatter.date : undefined;
      const lastmod = date ? `<lastmod>${xml(date)}</lastmod>` : "";
      return `  <url><loc>${xml(absUrl(base, p.url))}</loc>${lastmod}</url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** RSS from pages that carry a frontmatter `date` (the changelog convention), newest first. */
function buildRss(config: SiteConfig, pages: PageModel[], base: string): string {
  const dated = pages
    .filter((p) => typeof p.frontmatter.date === "string")
    .sort((a, b) => String(b.frontmatter.date).localeCompare(String(a.frontmatter.date)));
  const items = dated
    .map((p) => {
      const link = absUrl(base, p.url);
      const desc = p.description ? `<description>${xml(p.description)}</description>` : "";
      const date = `<pubDate>${xml(String(p.frontmatter.date))}</pubDate>`;
      const guid = `<guid isPermaLink="true">${xml(link)}</guid>`;
      return `    <item><title>${xml(p.title)}</title><link>${xml(link)}</link>${guid}${date}${desc}</item>`;
    })
    .join("\n");
  const channelLink = base || "/";
  const desc = config.site.description ? xml(config.site.description) : xml(config.site.name);
  const self = base
    ? `\n    <atom:link href="${xml(`${base}/rss.xml`)}" rel="self" type="application/rss+xml"/>`
    : "";
  const head = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>`;
  const channel = `    <title>${xml(config.site.name)}</title>\n    <link>${xml(channelLink)}</link>\n    <description>${desc}</description>${self}`;
  return `${head}\n${channel}\n${items}${items ? "\n" : ""}  </channel></rss>\n`;
}

function buildLlmsTxt(config: SiteConfig, pages: PageModel[], base: string): string {
  const lines = [`# ${config.site.name}`, ""];
  if (config.site.description) lines.push(`> ${config.site.description}`, "");
  lines.push("## Pages", "");
  for (const p of pages) {
    lines.push(
      `- [${p.title}](${absUrl(base, p.url)})${p.description ? `: ${p.description}` : ""}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function buildLlmsFullTxt(config: SiteConfig, pages: PageModel[], base: string): string {
  const parts = [`# ${config.site.name}`, ""];
  for (const p of pages) {
    parts.push(`# ${p.title}`, `URL: ${absUrl(base, p.url)}`, "", p.rawMd.trim(), "");
  }
  return `${parts.join("\n")}\n`;
}

function buildSkillMd(config: SiteConfig, pages: PageModel[], base: string): string {
  const description = config.site.description ?? `Documentation for ${config.site.name}.`;
  const lines = [
    "---",
    `name: ${config.site.name}`,
    `description: ${description}`,
    "---",
    "",
    `# ${config.site.name}`,
    "",
    "Reference the following documentation pages to answer questions.",
    "",
  ];
  for (const p of pages) {
    lines.push(
      `- [${p.title}](${absUrl(base, p.url)})${p.description ? `: ${p.description}` : ""}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function pickTitle(
  frontmatter: Record<string, unknown>,
  body: Root,
  slug: string,
  siteName: string,
): string {
  if (typeof frontmatter.title === "string" && frontmatter.title.trim()) {
    return frontmatter.title;
  }
  let heading: string | undefined;
  visit(body, "heading", (node) => {
    if (heading === undefined) heading = mdastToString(node).trim() || undefined;
  });
  if (heading) return heading;
  if (slug === "") return siteName;
  const last = slug.split("/").pop() ?? slug;
  return last.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function slugToUrl(slug: string): string {
  return slug === "" ? "/" : `/${slug}`;
}

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
