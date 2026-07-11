import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/resolve.js";

const fixtures = join(import.meta.dirname, "fixtures");

// Config spec AC-1 (minimal repo, no config, auto-discovers a working site)
// and AC-12 (deterministic resolution).
describe("resolveConfig: minimal repo (no config file)", () => {
  it("defaults the site name from the directory and discovers all pages", async () => {
    const r = await resolveConfig(join(fixtures, "minimal"));
    expect(r.site.name).toBe("minimal");
    expect(r.pages.map((p) => p.slug).sort()).toEqual([
      "",
      "guides",
      "guides/authentication",
      "quickstart",
    ]);
    expect(r.diagnostics).toEqual([]);
  });

  it("builds deterministic auto-navigation (index first, then alphabetical, folders as groups)", async () => {
    const r = await resolveConfig(join(fixtures, "minimal"));
    expect(r.nav).toEqual([
      { type: "page", slug: "" },
      { type: "page", slug: "quickstart" },
      {
        type: "group",
        label: "Guides",
        children: [
          { type: "page", slug: "guides" },
          { type: "page", slug: "guides/authentication" },
        ],
      },
    ]);
  });

  it("is deterministic across runs", async () => {
    const a = await resolveConfig(join(fixtures, "minimal"));
    const b = await resolveConfig(join(fixtures, "minimal"));
    expect(a).toEqual(b);
  });

  it("defaults branding to true when the config omits it", async () => {
    const r = await resolveConfig(join(fixtures, "minimal"));
    expect(r.branding).toBe(true);
  });
});

// Config spec AC-2 (explicit navigation is authoritative) and AC-7
// (a nav entry pointing at a missing page is reported).
describe("resolveConfig: configured repo", () => {
  it("uses the config site name and explicit navigation", async () => {
    const r = await resolveConfig(join(fixtures, "configured"));
    expect(r.site.name).toBe("Configured Docs");
    expect(r.nav).toEqual([
      { type: "page", slug: "setup" },
      {
        type: "group",
        label: "Advanced",
        children: [{ type: "page", slug: "advanced/webhooks" }],
      },
    ]);
  });

  it("reports a navigation reference that matches no page", async () => {
    const r = await resolveConfig(join(fixtures, "configured"));
    const missing = r.diagnostics.find((d) => d.code === "nav-missing-page");
    expect(missing).toBeDefined();
    expect(missing?.message).toContain("not-a-real-page");
  });

  it("honors branding:false for white-labeling", async () => {
    const r = await resolveConfig(join(fixtures, "configured"));
    expect(r.branding).toBe(false);
  });
});

// Config: top-level tabs and brand assets (logo/favicon).
describe("resolveConfig: tabbed repo", () => {
  it("resolves each tab into a labeled navigation subtree", async () => {
    const r = await resolveConfig(join(fixtures, "tabbed"));
    expect(r.tabs).toEqual([
      {
        label: "Guides",
        nav: [
          { type: "page", slug: "" },
          { type: "page", slug: "guide" },
        ],
      },
      { label: "API", nav: [{ type: "page", slug: "api" }] },
    ]);
  });

  it("passes through the logo and favicon", async () => {
    const r = await resolveConfig(join(fixtures, "tabbed"));
    expect(r.site.logo).toBe("/brand/logo.svg");
    expect(r.site.favicon).toBe("/brand/favicon.png");
  });

  it("leaves tabs undefined when the config omits them", async () => {
    const r = await resolveConfig(join(fixtures, "configured"));
    expect(r.tabs).toBeUndefined();
  });
});

// Hybrid-authoring spec HA-10/HA-18: apiReference.layout resolution.
describe("resolveConfig: apiReference layout", () => {
  it("defaults layout to single (plus path and label defaults)", async () => {
    const r = await resolveConfig(join(fixtures, "apiref"));
    expect(r.apiReference).toEqual({
      spec: "openapi.json",
      path: "/api-reference",
      label: "API Reference",
      layout: "single",
    });
  });

  it("passes an explicit pages layout through", async () => {
    const r = await resolveConfig(join(fixtures, "apiref-pages"));
    expect(r.apiReference).toEqual({
      spec: "openapi.json",
      path: "/reference",
      label: "API",
      layout: "pages",
    });
  });
});

// appearance.default: first-visit color scheme (visual-refresh spec VR-41).
describe("resolveConfig: appearance", () => {
  it("defaults to system", async () => {
    const r = await resolveConfig(join(fixtures, "minimal"));
    expect(r.appearance).toEqual({ default: "system" });
  });

  it("passes an explicit dark default through", async () => {
    const r = await resolveConfig(join(fixtures, "apiref-pages"));
    expect(r.appearance).toEqual({ default: "dark" });
  });
});
