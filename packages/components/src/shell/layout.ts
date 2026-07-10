import type { Breadcrumb, FinalNavNode, NavLink, TocNode } from "@readsmith/mdx";
import { renderNav } from "./nav.js";
import { renderToc } from "./toc.js";
import { HALLMARK_SVG, ICONS, esc, socialIcon } from "./util.js";

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
  /** Header links, for example a cross-link between the docs and the API reference. */
  links?: { label: string; href: string }[];
  /** Show the "Powered by Readsmith" badge. Defaults to true; false white-labels. */
  poweredBy?: boolean;
  /** Content footer: social links by platform (Mintlify-compatible `footer.socials`). */
  footer?: { socials?: Record<string, string> };
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
${header(site)}
${tabbar(site)}
<div class="rs-scrim" data-rs-scrim hidden></div>
<div class="rs-shell">
  <div class="rs-nav-col" data-rs-navcol>${renderNav(site.nav, page.slug)}</div>
  <main class="rs-main" id="rs-content" tabindex="-1">
    ${topbar(site, page)}
    <article class="rs-prose">${page.html}</article>
    ${pager(page)}
    ${pagefoot()}
    ${footer(site)}
  </main>
  ${renderToc(page.toc)}
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
<script>${THEME_INIT}</script>
</head>
<body>
${renderShellBody(site, page)}
${options.scriptHref ? `<script type="module" src="${esc(options.scriptHref)}"></script>` : ""}
</body>
</html>`;
}

export function header(site: ShellSite): string {
  const brand = site.logo
    ? `<img class="rs-brand__logo" src="${esc(site.logo)}" alt="${esc(site.name)}" />`
    : `${HALLMARK_SVG}<span class="rs-wordmark">${esc(site.name)}</span>`;
  return `<header class="rs-header">
  <button class="rs-icon-btn rs-header__burger" data-rs-nav-toggle aria-label="Open navigation" aria-expanded="false">${ICONS.menu}</button>
  <a class="rs-brand" href="/">${brand}</a>
  ${(site.links ?? [])
    .map((link) => `<a class="rs-headerlink" href="${esc(link.href)}">${esc(link.label)}</a>`)
    .join("")}
  <span class="rs-header__spacer"></span>
  <button class="rs-headerlink rs-headerlink--ask" data-rs-ask-open aria-label="Ask AI">${ICONS.sparkle}<span>Ask AI</span></button>
  <button class="rs-search" data-rs-palette-open aria-label="Search or ask AI">${ICONS.search}<span>Search or ask AI</span><kbd class="rs-kbd">⌘K</kbd></button>
  ${site.github ? `<a class="rs-icon-btn" href="${esc(site.github)}" aria-label="GitHub repository" rel="noopener">${ICONS.github}</a>` : ""}
  <button class="rs-icon-btn" data-rs-theme-toggle aria-label="Toggle light and dark">${ICONS.theme}</button>
</header>`;
}

export function tabbar(site: ShellSite): string {
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
