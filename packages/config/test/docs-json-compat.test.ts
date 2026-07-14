import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { docsJsonCompat } from "../src/docs-json-compat.js";
import { loadConfig } from "../src/load.js";

const codes = (r: ReturnType<typeof docsJsonCompat>) => r.diagnostics.map((d) => d.code);
const data = (input: unknown) => docsJsonCompat(input).data as Record<string, unknown>;

describe("docsJsonCompat", () => {
  it("passes a native config through unchanged with no diagnostics", () => {
    const native = {
      site: { name: "Docs" },
      navigation: ["index", { group: "Start", pages: ["a", "b"] }],
    };
    const r = docsJsonCompat(native);
    expect(r.data).toEqual(native);
    expect(r.diagnostics).toEqual([]);
  });

  it("passes a non-object input through unchanged", () => {
    expect(docsJsonCompat("nope").data).toBe("nope");
    expect(docsJsonCompat(null).diagnostics).toEqual([]);
  });

  it("lifts top-level name/logo/favicon under site and clears the top-level name", () => {
    const out = data({ name: "Acme", logo: { light: "/l.svg" }, favicon: "/f.svg" });
    expect(out.site).toEqual({ name: "Acme", logo: { light: "/l.svg" }, favicon: "/f.svg" });
    expect(out.name).toBeUndefined();
  });

  it("never overwrites an existing site object", () => {
    const out = data({ name: "Top", site: { name: "Kept" } });
    expect(out.site).toEqual({ name: "Kept" });
  });

  it("drops docs.json colors with a diagnostic", () => {
    const r = docsJsonCompat({ name: "Acme", colors: { primary: "#0f8b7e" } });
    expect(codes(r)).toContain("compat-colors");
    expect((r.data as Record<string, unknown>).colors).toBeUndefined();
  });

  it("keeps supported contextual.options and drops unknown ones with a diagnostic", () => {
    const r = docsJsonCompat({
      site: { name: "x" },
      contextual: { options: ["copy", "chatgpt", "cursor", "gemini"] },
    });
    expect((r.data as Record<string, unknown>).contextual).toEqual({
      options: ["copy", "chatgpt", "cursor"],
    });
    expect(codes(r)).toContain("compat-contextual");
  });

  it("maps navigation.tabs with groups into our tabs[], inlining string pages", () => {
    const out = data({
      site: { name: "x" },
      navigation: {
        tabs: [{ tab: "Guides", groups: [{ group: "Start", pages: ["index", "quickstart"] }] }],
      },
    });
    expect(out.tabs).toEqual([
      { tab: "Guides", pages: [{ group: "Start", pages: ["index", "quickstart"] }] },
    ]);
    expect(out.navigation).toBeUndefined();
  });

  it("carries a tab icon from docs.json tabs", () => {
    const out = data({
      site: { name: "x" },
      navigation: { tabs: [{ tab: "Guides", icon: "book", pages: ["a"] }] },
    });
    expect(out.tabs).toEqual([{ tab: "Guides", pages: ["a"], icon: "book" }]);
  });

  it("carries a tab dropdown menu into our tab.menu (flattening its groups/pages)", () => {
    const r = docsJsonCompat({
      site: { name: "x" },
      navigation: {
        tabs: [
          {
            tab: "API",
            menu: [
              { item: "REST", icon: "code", pages: ["api/rest"] },
              { item: "SDKs", groups: [{ group: "Langs", pages: ["sdk/ts"] }] },
            ],
          },
        ],
      },
    });
    expect((r.data as Record<string, unknown>).tabs).toEqual([
      {
        tab: "API",
        pages: [],
        menu: [
          { item: "REST", pages: ["api/rest"], icon: "code" },
          { item: "SDKs", pages: [{ group: "Langs", pages: ["sdk/ts"] }] },
        ],
      },
    ]);
    expect(codes(r)).not.toContain("compat-tab-menu"); // supported now, not dropped
  });

  it("degrades products to tabs with a diagnostic", () => {
    const r = docsJsonCompat({
      site: { name: "x" },
      navigation: { products: [{ product: "Core", pages: ["core/index"] }] },
    });
    expect(codes(r)).toContain("compat-products");
    expect((r.data as Record<string, unknown>).tabs).toEqual([
      { tab: "Core", pages: ["core/index"] },
    ]);
  });

  it("degrades dropdowns to tabs with a diagnostic", () => {
    const r = docsJsonCompat({
      site: { name: "x" },
      navigation: { dropdowns: [{ dropdown: "Tools", pages: ["tools/x"] }] },
    });
    expect(codes(r)).toContain("compat-dropdowns");
    expect((r.data as Record<string, unknown>).tabs).toEqual([
      { tab: "Tools", pages: ["tools/x"] },
    ]);
  });

  it("carries a group icon in both the string and object docs.json forms", () => {
    const asString = data({
      site: { name: "x" },
      navigation: { groups: [{ group: "G", icon: "book", pages: ["a"] }] },
    });
    expect(asString.navigation).toEqual([{ group: "G", pages: ["a"], icon: "book" }]);
    const asObject = data({
      site: { name: "x" },
      navigation: {
        groups: [{ group: "G", icon: { name: "book", library: "lucide" }, pages: ["a"] }],
      },
    });
    expect(asObject.navigation).toEqual([{ group: "G", pages: ["a"], icon: "book" }]);
  });

  it("carries group tag and expanded from docs.json groups", () => {
    const out = data({
      site: { name: "x" },
      navigation: {
        groups: [{ group: "Start", tag: "BETA", expanded: false, pages: ["a"] }],
      },
    });
    expect(out.navigation).toEqual([
      { group: "Start", pages: ["a"], tag: "BETA", expanded: false },
    ]);
  });

  it("maps top-level groups/pages into our navigation array", () => {
    const out = data({
      site: { name: "x" },
      navigation: { groups: [{ group: "G", pages: ["a"] }], pages: ["b"] },
    });
    expect(out.navigation).toEqual([{ group: "G", pages: ["a"] }, "b"]);
  });

  it("drops anchors/versions/languages/global with one diagnostic each", () => {
    const r = docsJsonCompat({
      site: { name: "x" },
      navigation: { pages: ["a"], anchors: [{}], versions: [{}], languages: [{}], global: {} },
    });
    expect(codes(r)).toEqual(
      expect.arrayContaining([
        "compat-anchors",
        "compat-versions",
        "compat-languages",
        "compat-global",
      ]),
    );
  });

  it("recurses nested groups, inlines a bare { pages }, and drops external link items", () => {
    const out = data({
      site: { name: "x" },
      navigation: {
        pages: [
          { group: "Outer", pages: ["a", { group: "Inner", pages: ["b"] }] },
          { pages: ["c"] },
          { page: "", href: "https://x.com" },
        ],
      },
    });
    expect(out.navigation).toEqual([
      { group: "Outer", pages: ["a", { group: "Inner", pages: ["b"] }] },
      "c",
    ]);
  });

  it("end-to-end: a real docs.json config now loads (was two parse errors)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rs-mint-"));
    await writeFile(
      join(dir, "docs.json"),
      JSON.stringify({
        theme: "mint",
        name: "Acme Docs",
        colors: { primary: "#0f8b7e" },
        logo: { light: "/logo/light.svg", dark: "/logo/dark.svg" },
        navigation: {
          tabs: [
            { tab: "Guides", groups: [{ group: "Start", pages: ["index", "quickstart"] }] },
            { tab: "API", menu: [{ item: "Reference", pages: ["api/intro"] }] },
          ],
        },
      }),
    );
    const { config, diagnostics } = await loadConfig(dir);
    expect(config).not.toBeNull();
    expect(config?.site.name).toBe("Acme Docs");
    expect(config?.tabs?.[0]).toEqual({
      tab: "Guides",
      pages: [{ group: "Start", pages: ["index", "quickstart"] }],
    });
    // Only warnings survive; no error diagnostics (it parses).
    expect(diagnostics.every((d) => d.severity === "warning")).toBe(true);
  });
});
