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

  it("adds the MCP connect group with a basePath-correct canonical endpoint only when the site serves MCP", () => {
    const bare = renderShellBody(site, page);
    expect(bare).not.toContain("Add to Cursor"); // no site.mcp -> no connect group

    const connected: ShellSite = { ...site, url: "https://acme.dev/docs", mcp: true };
    const html = renderShellBody(connected, page);
    expect(html).toContain("Add to Cursor");
    expect(html).toContain("Add to VS Code");
    // canonical MCP path (answers on standalone AND multi-tenant), carrying the
    // site's subpath from site.url's pathname
    expect(html).toContain('data-rs-mcp-url="https://acme.dev/docs/_readsmith/mcp"');
  });

  it("builds the /md url from the page slug, not its baked (subpath) url", () => {
    // A subpath-baked page: url carries /docs, slug does not. The /md link must
    // key by slug (/md/guide/setup), never /md/docs/guide/setup.
    const subpath = renderShellBody(site, {
      ...page,
      url: "/docs/guide/setup",
      slug: "guide/setup",
    });
    expect(subpath).toContain('data-rs-md-url="/md/guide/setup"');
    expect(subpath).not.toContain("/md/docs/");
  });

  it("prefixes the /md url with the active version (base -> version -> /md -> slug)", () => {
    const versioned = renderShellBody(
      { ...site, versionPrefix: "/v1" },
      { ...page, slug: "guide/setup" },
    );
    expect(versioned).toContain('data-rs-md-url="/v1/md/guide/setup"');

    const both = renderShellBody(
      { ...site, basePath: "/docs", versionPrefix: "/v1" },
      { ...page, slug: "guide" },
    );
    expect(both).toContain('data-rs-md-url="/docs/v1/md/guide"');
  });

  it("honors a trimmed contextual.options list", () => {
    const html = renderShellBody({ ...site, contextual: ["copy"] }, page);
    expect(html).toContain("Copy as Markdown");
    expect(html).not.toContain("chatgpt.com");
    expect(html).not.toContain("View as Markdown");
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

  it("renders a tab dropdown (details) with destinations and marks the active one", () => {
    const dropdown: ShellSite = {
      ...site,
      tabs: [
        {
          label: "API",
          url: "/api/rest",
          active: true,
          menu: [
            { label: "REST", url: "/api/rest", active: true },
            { label: "SDKs", url: "/sdk/ts", active: false },
          ],
        },
      ],
    };
    const html = renderShellBody(dropdown, page);
    expect(html).toContain('class="rs-tab-menu"');
    expect(html).toContain("<summary");
    expect(html).toContain('class="rs-tab-menu__item is-active"');
    expect(html).toContain('href="/sdk/ts"');
  });

  it("injects a pre-resolved tab icon before the tab label", () => {
    const svg = '<svg class="rs-nav__icon" aria-hidden="true"><path d="M1 1"/></svg>';
    const tabbed: ShellSite = {
      ...site,
      tabs: [{ label: "Guides", url: "/g", active: true, icon: svg }],
    };
    const html = renderShellBody(tabbed, page);
    expect(html).toContain(svg);
    expect(html.indexOf("rs-nav__icon")).toBeLessThan(html.indexOf("Guides"));
  });

  it("renders a logo image in place of the wordmark when a logo is set", () => {
    const html = renderShellBody({ ...site, logo: "/logo.svg" }, page);
    expect(html).toContain('class="rs-brand__logo"');
    expect(html).toContain('src="/logo.svg"');
    expect(html).not.toContain("rs-wordmark");
  });

  it("defaults the brand link to the docs home", () => {
    const html = renderShellBody(site, page);
    expect(html).toContain('class="rs-brand" href="/"');
  });

  it("points the brand at homeUrl when set, external gets rel=noopener", () => {
    const html = renderShellBody({ ...site, homeUrl: "https://cruciblehq.dev" }, page);
    expect(html).toContain('class="rs-brand" href="https://cruciblehq.dev" rel="noopener"');
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

describe("version selector", () => {
  const withVersions = (items: NonNullable<ShellSite["versions"]>["items"]): ShellSite => ({
    ...site,
    versions: { activeLabel: "v2 (latest)", items },
  });

  it("renders a disclosure with entries, tag badges, and an active marker", () => {
    const html = renderShellBody(
      withVersions([
        { label: "v2 (latest)", href: "/", active: true, tag: "latest" },
        { label: "v1", href: "/v1", active: false, tag: "deprecated" },
      ]),
      page,
    );
    expect(html).toContain("rs-verpicker");
    expect(html).toContain('aria-current="true"'); // the active version
    expect(html).toContain("Latest"); // tag badge label
    expect(html).toContain("Deprecated");
    expect(html).toContain('href="/v1"');
  });

  it("renders no selector for a single version, keeping the chrome unchanged (FR-12)", () => {
    const one = renderShellBody(withVersions([{ label: "v2", href: "/", active: true }]), page);
    expect(one).not.toContain("rs-verpicker");
    expect(renderShellBody(site, page)).not.toContain("rs-verpicker");
  });
});
