import type { Breadcrumb, FinalNavNode, NavLink, TocNode } from "@readsmith/mdx";
import { renderNav } from "./nav.js";
import { renderToc } from "./toc.js";
import { HALLMARK_SVG, ICONS, esc } from "./util.js";

export interface ShellSite {
  name: string;
  nav: FinalNavNode[];
  /** Optional GitHub URL for the header link. */
  github?: string;
  description?: string;
  /** Canonical base URL, used to build absolute "open in ChatGPT/Claude" links. */
  url?: string;
  /** Logo image URL. When set, replaces the wordmark in the header. */
  logo?: string;
  /** Top-level navigation tabs. When present, a tab bar renders below the header. */
  tabs?: ShellTab[];
  /** Show the "Powered by Readsmith" badge. Defaults to true; false white-labels. */
  poweredBy?: boolean;
}

export interface ShellTab {
  label: string;
  url: string;
  active: boolean;
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
}

export interface DocumentOptions {
  /** Href of the stylesheet (`@readsmith/components/styles.css`). */
  stylesheetHref?: string;
  /** Href of the island runtime module that calls `hydrate()`. */
  scriptHref?: string;
  lang?: string;
}

/** Sets the theme before first paint from the persisted choice, so there is no flash. */
const THEME_INIT =
  "(function(){try{var t=localStorage.getItem('rs-theme');if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}})();";

/**
 * The reading shell body: skip link, header, three-column layout (nav, content,
 * on-this-page TOC), pager, and the command palette. Returns body-level HTML;
 * `renderDocument` wraps it into a full page. The content column is measure
 * constrained and the whole thing collapses responsively.
 */
export function renderShellBody(site: ShellSite, page: ShellPage): string {
  return `<a class="rs-skip" href="#rs-content">Skip to content</a>
<div class="rs-progress" data-rs-progress aria-hidden="true"></div>
${header(site)}
${tabbar(site)}
<div class="rs-scrim" data-rs-scrim hidden></div>
<div class="rs-shell">
  <div class="rs-nav-col" data-rs-navcol>${renderNav(site.nav, page.slug)}${
    site.poweredBy === false ? "" : poweredBy()
  }</div>
  <main class="rs-main" id="rs-content" tabindex="-1">
    ${topbar(site, page)}
    <article class="rs-prose">${page.html}</article>
    ${pager(page)}
    ${pagefoot()}
  </main>
  ${renderToc(page.toc)}
</div>
${palette(site)}`;
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
<script>${THEME_INIT}</script>
</head>
<body>
${renderShellBody(site, page)}
${options.scriptHref ? `<script type="module" src="${esc(options.scriptHref)}"></script>` : ""}
</body>
</html>`;
}

function header(site: ShellSite): string {
  const brand = site.logo
    ? `<img class="rs-brand__logo" src="${esc(site.logo)}" alt="${esc(site.name)}" />`
    : `${HALLMARK_SVG}<span class="rs-wordmark">${esc(site.name)}</span>`;
  return `<header class="rs-header">
  <button class="rs-icon-btn rs-header__burger" data-rs-nav-toggle aria-label="Open navigation" aria-expanded="false">${ICONS.menu}</button>
  <a class="rs-brand" href="/">${brand}</a>
  <span class="rs-header__spacer"></span>
  <button class="rs-search" data-rs-palette-open aria-label="Search or ask AI">${ICONS.search}<span>Search or ask AI</span><kbd class="rs-kbd">⌘K</kbd></button>
  ${site.github ? `<a class="rs-icon-btn" href="${esc(site.github)}" aria-label="GitHub repository" rel="noopener">${ICONS.github}</a>` : ""}
  <button class="rs-icon-btn" data-rs-theme-toggle aria-label="Toggle light and dark">${ICONS.theme}</button>
</header>`;
}

function tabbar(site: ShellSite): string {
  if (!site.tabs || site.tabs.length === 0) return "";
  const tabs = site.tabs
    .map(
      (tab) =>
        `<a class="rs-tab${tab.active ? " is-active" : ""}" href="${esc(tab.url)}"${
          tab.active ? ' aria-current="page"' : ""
        }>${esc(tab.label)}</a>`,
    )
    .join("");
  return `<nav class="rs-tabbar" aria-label="Sections">${tabs}</nav>`;
}

function topbar(site: ShellSite, page: ShellPage): string {
  const mdUrl = `/md${page.url === "/" ? "" : page.url}`;
  const base = site.url ? site.url.replace(/\/+$/, "") : "";
  const absMd = base ? base + mdUrl : mdUrl;
  const prompt = encodeURIComponent(
    `Read ${absMd} and help me with questions about the "${page.title}" page.`,
  );
  return `<div class="rs-topbar">
  ${breadcrumbs(page.breadcrumbs)}
  <div class="rs-menu-wrap">
    <button class="rs-icon-btn" data-rs-menu-toggle aria-haspopup="true" aria-expanded="false" aria-label="Page actions">${ICONS.kebab}</button>
    <div class="rs-menu" data-rs-menu role="menu" hidden>
      <button role="menuitem" data-rs-copy-md data-rs-md-url="${esc(mdUrl)}">${ICONS.markdown}Copy as Markdown</button>
      <button role="menuitem" data-rs-copy-url>${ICONS.link}Copy page URL</button>
      <div class="rs-menu__sep"></div>
      <a role="menuitem" href="${esc(mdUrl)}" target="_blank" rel="noopener">${ICONS.markdown}View as Markdown</a>
      <a role="menuitem" href="https://chatgpt.com/?q=${prompt}" target="_blank" rel="noopener">${ICONS.ai}Open in ChatGPT</a>
      <a role="menuitem" href="https://claude.ai/new?q=${prompt}" target="_blank" rel="noopener">${ICONS.ai}Open in Claude</a>
    </div>
  </div>
</div>`;
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

function pager(page: ShellPage): string {
  if (!page.prev && !page.next) return "";
  const prev = page.prev
    ? `<a class="rs-pager__link rs-pager__prev" href="${esc(page.prev.url)}"><span class="rs-pager__dir">Previous</span><span class="rs-pager__title">${esc(
        page.prev.title,
      )}</span></a>`
    : "<span></span>";
  const next = page.next
    ? `<a class="rs-pager__link rs-pager__next" href="${esc(page.next.url)}"><span class="rs-pager__dir">Next</span><span class="rs-pager__title">${esc(
        page.next.title,
      )}</span></a>`
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

function poweredBy(): string {
  return `<a class="rs-poweredby" href="${READSMITH_URL}" target="_blank" rel="noopener">${HALLMARK_SVG}<span>Powered by <strong>Readsmith</strong></span></a>`;
}

function palette(site: ShellSite): string {
  return `<div class="rs-palette" data-rs-palette role="dialog" aria-modal="true" aria-label="Search ${esc(
    site.name,
  )}" hidden>
  <div class="rs-palette__box">
    <div class="rs-palette__input">${ICONS.search}<input type="text" data-rs-palette-input placeholder="Search docs, or ask a question" autocomplete="off" aria-label="Search"><kbd class="rs-kbd">Esc</kbd></div>
    <div class="rs-palette__results" data-rs-palette-results></div>
    <div class="rs-palette__foot"><span>&#8593;&#8595; to navigate</span><span>&#8629; to open</span><span>Esc to close</span></div>
  </div>
</div>`;
}
