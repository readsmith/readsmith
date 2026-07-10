import { describe, expect, it } from "vitest";
import {
  type AssembleInput,
  type NavNode,
  type SiteConfig,
  assembleSite,
} from "../src/assemble.js";
import type { ComponentRegistry } from "../src/render.js";

const registry: ComponentRegistry = {};

/**
 * Item 10, problems B and C.
 *
 * `hidden` and `noindex` are different promises. `hidden` unlists a page from the
 * nav, the feeds, and the AI index, but the page is still served and a crawler
 * that finds a link to it will index it. `noindex` is what actually tells the
 * crawler no.
 */
function build(files: Record<string, string>, nav?: NavNode[]) {
  const pages = Object.keys(files).map((path) => ({
    path,
    slug: path === "index.md" ? "" : path.replace(/\.md$/, ""),
  }));
  const config: SiteConfig = {
    site: { name: "Docs" },
    pages,
    nav: nav ?? pages.map((p) => ({ type: "page", slug: p.slug }) as NavNode),
  };
  const input: AssembleInput = {
    config,
    readPage: (p) => files[p] ?? "",
    registry,
  };
  return assembleSite(input);
}

const page = (fm: string, body = "# Heading\n\nText.\n") => `---\n${fm}\n---\n\n${body}`;

describe("noindex", () => {
  // AC-10.3
  it("AC-10.3: noindex drops the page from the sitemap and flags it for a robots meta", async () => {
    const site = await build({
      "index.md": page("title: Home"),
      "draft.md": page("title: Draft\nnoindex: true"),
    });
    const draft = site.pages.find((p) => p.slug === "draft");
    expect(draft?.noindex).toBe(true);
    expect(draft?.hidden).toBe(false); // still listed, still served
    expect(site.sitemap).not.toContain("<loc>/draft</loc>");
    expect(site.sitemap).toContain("<loc>/</loc>");
  });

  it("a noindex page stays in the nav and the AI index (it is not hidden)", async () => {
    const site = await build({
      "index.md": page("title: Home"),
      "draft.md": page("title: Draft\nnoindex: true"),
    });
    expect(site.nav.map((n) => n.type === "page" && n.slug)).toContain("draft");
    // chunk.path is the page URL (search deep-links are built from it); the source
    // file survives as page_id.
    expect(site.searchChunks.some((c) => c.path === "/draft")).toBe(true);
    expect(site.searchChunks.some((c) => c.page_id === "draft.md")).toBe(true);
  });

  // AC-10.4
  it("AC-10.4: hidden implies noindex", async () => {
    const site = await build({
      "index.md": page("title: Home"),
      "secret.md": page("title: Secret\nhidden: true"),
    });
    const secret = site.pages.find((p) => p.slug === "secret");
    expect(secret?.hidden).toBe(true);
    expect(secret?.noindex).toBe(true);
    expect(site.sitemap).not.toContain("<loc>/secret</loc>");
  });

  // AC-10.4
  it("AC-10.4: an explicit noindex:false overrides the implication", async () => {
    const site = await build({
      "index.md": page("title: Home"),
      "unlisted.md": page("title: Unlisted\nhidden: true\nnoindex: false"),
    });
    const unlisted = site.pages.find((p) => p.slug === "unlisted");
    expect(unlisted?.hidden).toBe(true);
    expect(unlisted?.noindex).toBe(false);
    // Hidden still keeps it out of the sitemap: the sitemap honors both flags.
    expect(site.sitemap).not.toContain("<loc>/unlisted</loc>");
  });

  it("defaults to indexable", async () => {
    const site = await build({ "index.md": page("title: Home") });
    expect(site.pages[0]?.noindex).toBe(false);
  });
});

describe("sidebarTitle", () => {
  // AC-10.5
  it("AC-10.5: labels the nav while title drives the page", async () => {
    const site = await build({
      "index.md": page("title: Home"),
      "auth.md": page("title: Authenticating with the Widget API\nsidebarTitle: Auth"),
    });
    const auth = site.pages.find((p) => p.slug === "auth");
    expect(auth?.title).toBe("Authenticating with the Widget API");
    expect(auth?.sidebarTitle).toBe("Auth");

    const navNode = site.nav.find((n) => n.type === "page" && n.slug === "auth");
    expect(navNode?.type === "page" && navNode.title).toBe("Auth");
  });

  // AC-10.6
  it("AC-10.6: without sidebarTitle the nav label is the title", async () => {
    const site = await build({ "index.md": page("title: Home") });
    const navNode = site.nav[0];
    expect(navNode?.type === "page" && navNode.title).toBe("Home");
  });

  // AC-10.7
  it("AC-10.7: never alters the rendered H1", async () => {
    const site = await build({
      "index.md": page("title: Long Page Title\nsidebarTitle: Short", "# Long Page Title\n"),
    });
    expect(site.pages[0]?.html).toContain("Long Page Title");
    expect(site.pages[0]?.html).not.toContain("Short");
  });

  it("ignores a blank sidebarTitle", async () => {
    const site = await build({ "index.md": page('title: Home\nsidebarTitle: "   "') });
    expect(site.pages[0]?.sidebarTitle).toBeUndefined();
  });

  it("labels prev/next with the sidebar title", async () => {
    const site = await build({
      "index.md": page("title: Home"),
      "auth.md": page("title: A Very Long Authentication Guide\nsidebarTitle: Auth"),
    });
    const home = site.pages.find((p) => p.slug === "");
    expect(home?.next?.title).toBe("Auth");
  });
});
