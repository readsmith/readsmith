import type { Breadcrumb, FinalNavNode, NavLink, TocNode } from "@readsmith/mdx";
import type { NormalizedSpec } from "@readsmith/model";
import {
  type OperationPageApi,
  type SchemaPageApi,
  renderOperationMain,
  renderSchemaMain,
} from "../api/operation.js";
import {
  type ContextualOption,
  DEFAULT_CONTEXTUAL_OPTIONS,
  renderContextMenu,
} from "./contextual.js";
import { renderNav } from "./nav.js";
import { renderToc } from "./toc.js";
import { HALLMARK_SVG, HALLMARK_SVG_SHIMMER, ICONS, esc, socialIcon } from "./util.js";

export interface ShellSite {
  name: string;
  nav: FinalNavNode[];
  /** Optional GitHub URL for the header link. */
  github?: string;
  description?: string;
  /** Canonical base URL, used to build absolute "open in ChatGPT/Claude" links. */
  url?: string;
  /** Where the header brand links. Defaults to the site's mount point. */
  homeUrl?: string;
  /** Base path when the site serves under a parent domain's subpath (spec
   * subpath-hosting SP-3). Page and tab URLs already carry it; this covers the
   * shell's own constructed URLs (brand home, the /md projection links). */
  basePath?: string;
  /** Logo image URL, or a per-theme pair. When set, replaces the wordmark. */
  logo?: string | { light: string; dark: string };
  /** Top-level navigation tabs. When present, a tab bar renders below the header. */
  tabs?: ShellTab[];
  /** Header links, for example a cross-link between the docs and the API reference. */
  links?: { label: string; href: string }[];
  /** Show the "Powered by Readsmith" badge. Defaults to true; false white-labels. */
  poweredBy?: boolean;
  /** Content footer: social links by platform (docs.json-compatible `footer.socials`). */
  footer?: { socials?: Record<string, string> };
  /** Which page-actions menu items to show (docs.json-compatible `contextual.options`).
   * Undefined falls back to the default set. */
  contextual?: ContextualOption[];
  /** True when the site serves an MCP endpoint. Enables the "Add to Cursor /
   * VS Code / Copy MCP URL" connect group; the endpoint URL is built here from
   * url + basePath + the canonical MCP path. */
  mcp?: boolean;
}

/**
 * The MCP endpoint's canonical path. The friendly `/mcp` alias is a per-host
 * rewrite that exists on the standalone app but not on the multi-tenant serve,
 * so agent-facing links use the canonical path, which answers on every host.
 */
const MCP_ENDPOINT_PATH = "/_readsmith/mcp";

/** A destination in a tab's dropdown menu. */
export interface ShellTabMenuItem {
  label: string;
  url: string;
  active: boolean;
  /** Pre-resolved inline SVG for the item icon. */
  icon?: string;
}

export interface ShellTab {
  label: string;
  url: string;
  active: boolean;
  /** Pre-resolved inline SVG for the tab icon (from the bundled icon set). */
  icon?: string;
  /** Dropdown destinations; when present, the tab is a disclosure dropdown. */
  menu?: ShellTabMenuItem[];
}

const READSMITH_URL = "https://readsmith.dev";

export interface ShellPage {
  title: string;
  description?: string;
  url: string;
  slug: string;
  /** The rendered page content (goes inside `.rs-prose`). Trusted owner HTML. */
  html: string;
  toc: TocNode[];
  breadcrumbs: Breadcrumb[];
  prev?: NavLink;
  next?: NavLink;
  /** "api-operation" pages swap the TOC for the assay console rail;
   * "api-schema" pages stay doc-shaped with a generated fields section. */
  kind?: "doc" | "api-operation" | "api-schema";
  /** The operation binding of a hybrid page (mirrors the mdx PageApi shape). */
  api?: OperationPageApi & { method?: string; path?: string };
  /** The schema binding of a data-model page. */
  apiSchema?: SchemaPageApi;
}

export interface ShellBodyOptions {
  /** The normalized spec hybrid operation pages render their sections from. */
  apiSpec?: NormalizedSpec | null;
}

export interface DocumentOptions {
  /** Href of the stylesheet (`@readsmith/components/styles.css`). */
  stylesheetHref?: string;
  /** Href of the island runtime module that calls `hydrate()`. */
  scriptHref?: string;
  lang?: string;
  /** The normalized spec hybrid operation pages render their sections from. */
  apiSpec?: NormalizedSpec | null;
  /** First-visit color scheme; "system" (default) follows the visitor's OS. */
  defaultMode?: "system" | "light" | "dark";
}

/**
 * The inline script that sets the theme before first paint, so there is no
 * flash: the visitor's persisted choice wins; otherwise a site-configured
 * default mode ("light" / "dark") pins that scheme, and "system" leaves it to
 * the CSS media queries. The parameter is enum-typed, so the interpolation
 * cannot carry anything but those literals.
 */
export function themeInitScript(defaultMode: "system" | "light" | "dark" = "system"): string {
  const fallback = defaultMode === "system" ? "" : `||'${defaultMode}'`;
  return `(function(){try{var t=localStorage.getItem('rs-theme')${fallback};if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;
}

/**
 * The reading shell body: skip link, header, three-column layout (nav, content,
 * on-this-page TOC), pager, and the command palette. Returns body-level HTML;
 * `renderDocument` wraps it into a full page. The content column is measure
 * constrained and the whole thing collapses responsively.
 *
 * A `kind: "api-operation"` page renders the hybrid operation layout instead:
 * the assay console takes the right rail (no TOC), the measure cap lifts for
 * the operation grid, and the content composes per the spec's order (title,
 * method bar, description, authored prose, generated sections).
 */
export function renderShellBody(
  site: ShellSite,
  page: ShellPage,
  options: ShellBodyOptions = {},
): string {
  const isOp = page.kind === "api-operation" && page.api !== undefined;
  const isSchema = page.kind === "api-schema" && page.apiSchema !== undefined;
  // The tag stands in for missing breadcrumbs, so the eyebrow never goes blank.
  const crumbPage =
    isOp && page.breadcrumbs.length === 0 && page.api?.tag
      ? { ...page, breadcrumbs: [{ label: page.api.tag }] }
      : page;
  const content = isOp
    ? renderOperationMain(page, options.apiSpec)
    : isSchema
      ? renderSchemaMain(page, options.apiSpec)
      : `<article class="rs-prose">${page.html}</article>`;
  return `<a class="rs-skip" href="#rs-content">Skip to content</a>
${header(site)}
${tabbar(site)}
<div class="rs-scrim" data-rs-scrim hidden></div>
<div class="rs-shell${isOp ? " rs-shell--op" : ""}">
  <div class="rs-nav-col" data-rs-navcol>${renderNav(site.nav, page.slug)}</div>
  <main class="rs-main${isOp ? " rs-main--op" : ""}" id="rs-content" tabindex="-1">
    ${topbar(site, crumbPage)}
    ${content}
    ${pager(page)}
    ${pagefoot()}
    ${footer(site)}
  </main>
  ${isOp ? "" : renderToc(page.toc)}
</div>
${palette(site)}
${askConsole(site)}`;
}

/**
 * The Ask-AI console: a dark instrument docked on the right, populated by the
 * island. Always in the DOM (hidden) so the island can wire it; shown only when
 * the chat capability is present.
 */
export function askConsole(site: ShellSite): string {
  return `<aside class="rs-ask" data-rs-ask aria-label="Ask AI" hidden>
  <div class="rs-ask__resize" data-rs-ask-resize role="separator" aria-label="Resize the panel" tabindex="0"></div>
  <header class="rs-ask__head">
    <span class="rs-ask__brand">${ICONS.sparkle}<span>Ask AI</span></span>
    <div class="rs-ask__tools">
      <button class="rs-ask__tool" data-rs-ask-new type="button" aria-label="New conversation" title="New conversation">${ICONS.plus}</button>
      <button class="rs-ask__tool" data-rs-ask-expand type="button" aria-label="Expand" title="Expand">${ICONS.expand}</button>
      <button class="rs-ask__tool" data-rs-ask-close type="button" aria-label="Close" title="Close">${ICONS.close}</button>
    </div>
  </header>
  <p class="rs-ask__disclaimer">Answers are generated from these docs and may contain mistakes.</p>
  <div class="rs-ask__scroll" data-rs-ask-scroll></div>
  <form class="rs-ask__composer" data-rs-ask-form>
    <textarea class="rs-ask__input" data-rs-ask-input rows="1" placeholder="Ask about these docs&hellip;" aria-label="Ask about ${esc(
      site.name,
    )}"></textarea>
    <button class="rs-ask__send" type="submit" aria-label="Send">${ICONS.arrowUp}</button>
  </form>
</aside>`;
}

/** A complete, servable HTML document wrapping the shell body. */
export function renderDocument(
  site: ShellSite,
  page: ShellPage,
  options: DocumentOptions = {},
): string {
  const style = options.stylesheetHref ?? "/styles.css";
  const lang = options.lang ?? "en";
  const desc = page.description ?? site.description;
  return `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)} · ${esc(site.name)}</title>
${desc ? `<meta name="description" content="${esc(desc)}">\n` : ""}<link rel="stylesheet" href="${esc(style)}">
<script>${themeInitScript(options.defaultMode)}</script>
</head>
<body>
${renderShellBody(site, page, { apiSpec: options.apiSpec })}
${options.scriptHref ? `<script type="module" src="${esc(options.scriptHref)}"></script>` : ""}
</body>
</html>`;
}

/**
 * The brand slot: wordmark, a single logo, or a per-theme pair. A pair renders
 * BOTH images and lets the theme cascade show exactly one, so switching themes
 * never flashes and needs no JS.
 */
function brandHtml(site: ShellSite): string {
  const logo = site.logo;
  if (!logo) return `${HALLMARK_SVG_SHIMMER}<span class="rs-wordmark">${esc(site.name)}</span>`;
  const alt = esc(site.name);
  if (typeof logo === "string" || logo.light === logo.dark) {
    const src = typeof logo === "string" ? logo : logo.light;
    return `<img class="rs-brand__logo" src="${esc(src)}" alt="${alt}" />`;
  }
  return `<img class="rs-brand__logo rs-brand__logo--light" src="${esc(logo.light)}" alt="${alt}" /><img class="rs-brand__logo rs-brand__logo--dark" src="${esc(logo.dark)}" alt="${alt}" />`;
}

export function header(site: ShellSite): string {
  const brand = brandHtml(site);
  const home = site.homeUrl ?? (site.basePath || "/");
  const homeRel = /^https?:\/\//.test(home) ? ' rel="noopener"' : "";
  return `<header class="rs-header">
  <button class="rs-icon-btn rs-header__burger" data-rs-nav-toggle aria-label="Open navigation" aria-expanded="false">${ICONS.menu}</button>
  <a class="rs-brand" href="${esc(home)}"${homeRel}>${brand}</a>
  ${(site.links ?? [])
    .map((link) => `<a class="rs-headerlink" href="${esc(link.href)}">${esc(link.label)}</a>`)
    .join("")}
  <span class="rs-header__spacer"></span>
  <button class="rs-headerlink rs-headerlink--ask" data-rs-ask-open aria-expanded="false" aria-label="Ask AI">${ICONS.sparkle}<span>Ask AI</span></button>
  <button class="rs-search" data-rs-palette-open aria-label="Search or ask AI">${ICONS.search}<span>Search or ask AI</span><kbd class="rs-kbd">⌘K</kbd></button>
  ${site.github ? `<a class="rs-icon-btn" href="${esc(site.github)}" aria-label="GitHub repository" rel="noopener">${ICONS.github}</a>` : ""}
  <button class="rs-icon-btn" data-rs-theme-toggle aria-label="Toggle light and dark">${ICONS.theme}</button>
</header>`;
}

const TAB_CARET =
  '<svg class="rs-tab__caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

export function tabbar(site: ShellSite): string {
  if (!site.tabs || site.tabs.length === 0) return "";
  const tabs = site.tabs.map((tab) => renderTab(tab)).join("");
  return `<nav class="rs-tabbar" aria-label="Sections">${tabs}</nav>`;
}

/**
 * A tab is a link, or a native `<details>` disclosure dropdown when it carries a
 * `menu`. The disclosure works without JavaScript and is keyboard-accessible by
 * default; the island only adds outside-click/Esc close as an enhancement.
 */
function renderTab(tab: ShellTab): string {
  if (!tab.menu || tab.menu.length === 0) {
    return `<a class="rs-tab${tab.active ? " is-active" : ""}" href="${esc(tab.url)}"${
      tab.active ? ' aria-current="page"' : ""
    }>${tab.icon ?? ""}${esc(tab.label)}</a>`;
  }
  const items = tab.menu
    .map(
      (m) =>
        `<a class="rs-tab-menu__item${m.active ? " is-active" : ""}" href="${esc(m.url)}"${
          m.active ? ' aria-current="page"' : ""
        }>${m.icon ?? ""}${esc(m.label)}</a>`,
    )
    .join("");
  return `<details class="rs-tab-menu" data-rs-tabmenu><summary class="rs-tab${
    tab.active ? " is-active" : ""
  }">${tab.icon ?? ""}${esc(
    tab.label,
  )}${TAB_CARET}</summary><div class="rs-tab-menu__panel">${items}</div></details>`;
}

function topbar(site: ShellSite, page: ShellPage): string {
  // page.url carries any subpath prefix; the /md route lives under the same
  // prefix, so rebuild as base + /md + the page's base-relative path (SP-2).
  const bp = site.basePath ?? "";
  const rel = bp && page.url.startsWith(bp) ? page.url.slice(bp.length) || "/" : page.url;
  const mdUrl = `${bp}/md${rel === "/" ? "" : rel}`;
  const origin = siteOriginOf(site.url);
  const absMd = origin ? origin + mdUrl : mdUrl;
  const prompt = encodeURIComponent(
    `Read ${absMd} and help me with questions about the "${page.title}" page.`,
  );
  // The MCP connect group needs an absolute endpoint URL. The endpoint lives at
  // <basePath>/_readsmith/mcp, where basePath is the site's mount subpath
  // (site.url's pathname), so agents connect to the same host a browser would.
  const mcpUrl =
    site.mcp && origin ? origin + siteBasePathOf(site.url) + MCP_ENDPOINT_PATH : undefined;
  const menuBody = renderContextMenu({
    mdUrl,
    prompt,
    ...(mcpUrl ? { mcpUrl } : {}),
    serverName: mcpServerName(site.name),
    options: site.contextual ?? DEFAULT_CONTEXTUAL_OPTIONS,
  });
  return `<div class="rs-topbar">
  ${breadcrumbs(page.breadcrumbs)}
  <div class="rs-menu-wrap">
    <button class="rs-icon-btn" data-rs-menu-toggle aria-haspopup="true" aria-expanded="false" aria-label="Page actions">${ICONS.kebab}</button>
    <div class="rs-menu" data-rs-menu role="menu" hidden>${menuBody}</div>
  </div>
</div>`;
}

/** A stable, URL-safe server name for the MCP install links. */
function mcpServerName(siteName: string): string {
  const slug = siteName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `${slug}-docs` : "readsmith-docs";
}

function breadcrumbs(items: Breadcrumb[]): string {
  if (items.length === 0) return '<nav class="rs-breadcrumbs" aria-label="Breadcrumb"></nav>';
  const parts = items.map((item, i) => {
    const last = i === items.length - 1;
    const label = esc(item.label);
    const node =
      item.url && !last ? `<a href="${esc(item.url)}">${label}</a>` : `<span>${label}</span>`;
    return node;
  });
  return `<nav class="rs-breadcrumbs" aria-label="Breadcrumb">${parts.join(
    '<span class="rs-breadcrumbs__sep" aria-hidden="true">/</span>',
  )}</nav>`;
}

const CHEV_LEFT =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m14 6-6 6 6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHEV_RIGHT =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m10 6 6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* Prev/next as quiet chevroned text links; direction lives in the aria-label. */
function pager(page: ShellPage): string {
  if (!page.prev && !page.next) return "";
  const prev = page.prev
    ? `<a class="rs-pager__link rs-pager__prev" href="${esc(page.prev.url)}" aria-label="Previous: ${esc(
        page.prev.title,
      )}">${CHEV_LEFT}<span class="rs-pager__title">${esc(page.prev.title)}</span></a>`
    : "<span></span>";
  const next = page.next
    ? `<a class="rs-pager__link rs-pager__next" href="${esc(page.next.url)}" aria-label="Next: ${esc(
        page.next.title,
      )}"><span class="rs-pager__title">${esc(page.next.title)}</span>${CHEV_RIGHT}</a>`
    : "<span></span>";
  return `<nav class="rs-pager" aria-label="Pagination">${prev}${next}</nav>`;
}

function pagefoot(): string {
  return `<footer class="rs-pagefoot">
  <span>Was this page helpful?</span>
  <button class="rs-fbtn" type="button" data-rs-feedback="yes">Yes</button>
  <button class="rs-fbtn" type="button" data-rs-feedback="no">Could be better</button>
</footer>`;
}

/**
 * The content footer: socials left, powered-by right. Renders only when it has
 * content (socials configured, or branding on). The powered-by badge lives here
 * (one placement), not in the nav sidebar.
 */
function footer(site: ShellSite): string {
  const socials = Object.entries(site.footer?.socials ?? {})
    .map(
      ([platform, url]) =>
        `<a class="rs-footer__social" href="${esc(url)}" aria-label="${esc(platform)}" rel="noopener" target="_blank">${socialIcon(platform)}</a>`,
    )
    .join("");
  const powered =
    site.poweredBy === false
      ? ""
      : `<a class="rs-footer__powered" href="${READSMITH_URL}" target="_blank" rel="noopener">${HALLMARK_SVG}<span>Powered by <strong>Readsmith</strong></span></a>`;
  if (!socials && !powered) return "";
  return `<footer class="rs-footer">
  <div class="rs-footer__socials">${socials}</div>
  ${powered}
</footer>`;
}

export function palette(site: ShellSite): string {
  return `<div class="rs-palette" data-rs-palette role="dialog" aria-modal="true" aria-label="Search ${esc(
    site.name,
  )}" hidden>
  <div class="rs-palette__box">
    <div class="rs-palette__input">${ICONS.search}<input type="text" data-rs-palette-input placeholder="Search docs, or ask a question" autocomplete="off" aria-label="Search"><kbd class="rs-kbd">Esc</kbd></div>
    <div class="rs-palette__results" data-rs-palette-results></div>
    <div class="rs-palette__foot"><span><kbd class="rs-kbd">&#8593;&#8595;</kbd> navigate</span><span><kbd class="rs-kbd">&#8629;</kbd> open</span><span><kbd class="rs-kbd">&#8997;&#8629;</kbd> ask</span></div>
  </div>
</div>`;
}

/** The origin of a site URL ("" when unset/invalid); absolute URLs are origin + prefixed path. */
function siteOriginOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** The subpath the site is mounted under, from `site.url`'s pathname ("" at a root). */
function siteBasePathOf(url: string | undefined): string {
  if (!url) return "";
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    return path === "/" ? "" : path;
  } catch {
    return "";
  }
}
