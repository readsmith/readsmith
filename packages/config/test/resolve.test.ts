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
});
