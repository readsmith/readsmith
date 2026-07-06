import type { FinalNavNode, TocNode } from "@readsmith/mdx";
import { describe, expect, it } from "vitest";
import {
  type ShellPage,
  type ShellSite,
  renderDocument,
  renderNav,
  renderShellBody,
  renderToc,
} from "../src/shell/index.js";

const nav: FinalNavNode[] = [
  { type: "page", slug: "", url: "/", title: "Introduction" },
  {
    type: "group",
    label: "Guides",
    children: [
      { type: "page", slug: "guide/setup", url: "/guide/setup", title: "Setup" },
      { type: "page", slug: "guide/usage", url: "/guide/usage", title: "Usage" },
    ],
  },
];

const toc: TocNode[] = [
  { text: "Install", anchor: "install", depth: 2, children: [] },
  {
    text: "Usage",
    anchor: "usage",
    depth: 2,
    children: [{ text: "Run", anchor: "run", depth: 3, children: [] }],
  },
];

const site: ShellSite = { name: "Readsmith", nav, github: "https://github.com/x/y" };
const page: ShellPage = {
  title: "Setup",
  url: "/guide/setup",
  slug: "guide/setup",
  html: "<h1>Setup</h1><p>Install it.</p>",
  toc,
  breadcrumbs: [{ label: "Guides" }, { label: "Setup", url: "/guide/setup" }],
  prev: { slug: "", url: "/", title: "Introduction" },
  next: { slug: "guide/usage", url: "/guide/usage", title: "Usage" },
};

describe("renderNav", () => {
  it("marks the current page and renders groups as disclosures", () => {
    const html = renderNav(nav, "guide/setup");
    expect(html).toContain('href="/guide/setup"');
    expect(html).toContain("is-active");
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("<details");
    expect(html).toContain("Guides");
  });

  it("renders groups open by default so a section never auto-collapses", () => {
    expect(renderNav(nav, "guide/usage")).toContain('<details class="rs-nav__group" open>');
    expect(renderNav(nav, "")).toContain('<details class="rs-nav__group" open>');
  });
});

describe("renderToc", () => {
  it("links each heading by its anchor with a depth", () => {
    const html = renderToc(toc);
    expect(html).toContain('href="#install"');
    expect(html).toContain('href="#run"');
    expect(html).toContain('data-depth="3"');
    expect(html).toContain("rs-toc__marker");
  });

  it("renders nothing for a page with no headings", () => {
    expect(renderToc([])).toBe("");
  });
});

describe("renderShellBody", () => {
  it("assembles the header, nav, content, TOC, and palette", () => {
    const html = renderShellBody(site, page);
    expect(html).toContain("rs-header");
    expect(html).toContain("rs-nav__link");
    expect(html).toContain('id="rs-content"');
    expect(html).toContain("Install it."); // page html injected
    expect(html).toContain("rs-toc__link");
    expect(html).toContain("data-rs-palette");
    expect(html).toContain("rs-pager__next");
    expect(html).toContain("Copy as Markdown");
  });

  it("escapes dynamic text", () => {
    const evil: ShellSite = { name: "<script>", nav: [] };
    expect(renderShellBody(evil, { ...page, toc: [], breadcrumbs: [] })).not.toContain("<script>");
  });

  it("shows the Powered by Readsmith badge by default and hides it when white-labeled", () => {
    expect(renderShellBody(site, page)).toContain("Powered by");
    expect(renderShellBody({ ...site, poweredBy: false }, page)).not.toContain("Powered by");
  });

  it("renders no tab bar when the site has no tabs", () => {
    expect(renderShellBody(site, page)).not.toContain("rs-tabbar");
  });

  it("renders a tab bar and marks the active tab when tabs are present", () => {
    const tabbed: ShellSite = {
      ...site,
      tabs: [
        { label: "Guides", url: "/guide/setup", active: true },
        { label: "API", url: "/api", active: false },
      ],
    };
    const html = renderShellBody(tabbed, page);
    expect(html).toContain('class="rs-tabbar"');
    expect(html).toContain('class="rs-tab is-active"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('href="/api"');
  });

  it("renders a logo image in place of the wordmark when a logo is set", () => {
    const html = renderShellBody({ ...site, logo: "/logo.svg" }, page);
    expect(html).toContain('class="rs-brand__logo"');
    expect(html).toContain('src="/logo.svg"');
    expect(html).not.toContain("rs-wordmark");
  });
});

describe("renderDocument", () => {
  it("produces a full HTML document with a no-flash theme init", () => {
    const html = renderDocument(site, page, { stylesheetHref: "/s.css" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Setup · Readsmith</title>");
    expect(html).toContain('<link rel="stylesheet" href="/s.css">');
    expect(html).toContain("localStorage.getItem('rs-theme')");
    expect(html).toContain("</html>");
  });
});
