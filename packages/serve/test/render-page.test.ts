import type { FinalNavNode, PageModel, SiteBuild } from "@readsmith/mdx";
import { describe, expect, it } from "vitest";
import { renderPageFromBundle } from "../src/render-page.js";
import type { Bundle } from "../src/site.js";

const nav: FinalNavNode[] = [
  { type: "page", slug: "", url: "/", title: "Introduction" },
  { type: "page", slug: "guide/setup", url: "/guide/setup", title: "Setup" },
];

const pages = [
  {
    title: "Setup",
    url: "/guide/setup",
    slug: "guide/setup",
    html: "<h1>Setup</h1><p>Install it.</p>",
    toc: [],
    breadcrumbs: [],
  },
] as unknown as PageModel[];

function bundle(): Bundle {
  return {
    site: {
      build: { pages, nav } as unknown as SiteBuild,
      name: "Demo Docs",
      branding: true,
    },
    apiReference: null,
  };
}

describe("renderPageFromBundle", () => {
  it("renders a page from the given bundle into the shell", () => {
    const rendered = renderPageFromBundle(bundle(), "guide/setup");
    expect(rendered).not.toBeNull();
    expect(rendered?.page.slug).toBe("guide/setup");
    expect(rendered?.html).toContain("<p>Install it.</p>");
    expect(rendered?.html).toContain("Demo Docs");
    expect(rendered?.html).toContain('href="/guide/setup"');
  });

  it("returns null for a slug the bundle does not contain", () => {
    expect(renderPageFromBundle(bundle(), "no/such/page")).toBeNull();
  });

  it("is pure over the bundle: two bundles render independently", () => {
    const other = bundle();
    other.site.name = "Other Tenant";
    expect(renderPageFromBundle(bundle(), "guide/setup")?.html).toContain("Demo Docs");
    expect(renderPageFromBundle(other, "guide/setup")?.html).toContain("Other Tenant");
  });
});
