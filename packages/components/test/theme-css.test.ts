import { describe, expect, it } from "vitest";
import { themeToCss } from "../src/shell/theme-css.js";

describe("themeToCss", () => {
  it("returns empty for no theme", () => {
    expect(themeToCss(undefined)).toBe("");
    expect(themeToCss(null)).toBe("");
    expect(themeToCss({})).toBe("");
  });

  it("emits per-mode accent across the base cascade", () => {
    const css = themeToCss({ accent: { light: "#C0400A", dark: "#FF6A1F" } });
    // light default, dark media query, and both explicit data-theme overrides
    expect(css).toContain(":root:root:root{");
    expect(css).toContain("@media (prefers-color-scheme:dark)");
    expect(css).toContain(':root:root[data-theme="dark"]{');
    expect(css).toContain(':root:root[data-theme="light"]{');
    expect(css).toContain("--rs-accent:#C0400A");
    expect(css).toContain("--rs-accent:#FF6A1F");
  });

  it("applies a single string to both modes", () => {
    const css = themeToCss({ accent: "#C0400A" });
    const matches = css.match(/--rs-accent:#C0400A/g) ?? [];
    // light base + explicit light + dark media + explicit dark
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("derives the accent wash and focus ring from the accent", () => {
    const css = themeToCss({ accent: "#C0400A" });
    expect(css).toContain("--rs-accent-wash:color-mix(in srgb, #C0400A");
    expect(css).toContain("--rs-focus:#C0400A");
  });

  it("does not derive a wash when one is set explicitly", () => {
    const css = themeToCss({ accent: "#C0400A", accentWash: "rgba(0,0,0,0.1)" });
    expect(css).not.toContain("color-mix");
    expect(css).toContain("--rs-accent-wash:rgba(0,0,0,0.1)");
  });

  it("drops values that could break out of the declaration", () => {
    const css = themeToCss({
      // biome-ignore lint/suspicious/noExplicitAny: exercising untyped/hostile input
      accent: "#fff;} body{display:none}" as any,
      paper: "url(javascript:alert(1))",
      ink: "red",
    });
    expect(css).not.toContain("display:none");
    expect(css).not.toContain("url(");
    expect(css).not.toContain("javascript");
    // the safe value still lands
    expect(css).toContain("--rs-ink:red");
  });

  it("maps surface2 to the hyphenated token", () => {
    expect(themeToCss({ surface2: "#111" })).toContain("--rs-surface-2:#111");
  });

  it("emits font stacks once in the base block (theme-agnostic)", () => {
    const css = themeToCss({
      fontHeading: '"IBM Plex Sans", system-ui, sans-serif',
      fontWordmark: '"IBM Plex Mono", monospace',
    });
    expect(css).toContain('--rs-font-serif:"IBM Plex Sans", system-ui, sans-serif');
    expect(css).toContain('--rs-font-wordmark:"IBM Plex Mono", monospace');
    // fonts are not duplicated into a dark/data-theme block
    expect(css).not.toContain("data-theme");
    expect(css).not.toContain("prefers-color-scheme");
  });

  it("keeps fonts out of the per-mode blocks when colors are also set", () => {
    const css = themeToCss({
      accent: { light: "#C0400A", dark: "#FF6A1F" },
      fontHeading: "Inter, sans-serif",
    });
    const darkBlock = css.slice(css.indexOf('data-theme="dark"'));
    expect(darkBlock).not.toContain("--rs-font-serif");
    expect(css).toContain("--rs-font-serif:Inter, sans-serif");
  });

  it("derives the always-dark console accent from the dark accent", () => {
    const css = themeToCss({ accent: { light: "#C0400A", dark: "#FF6A1F" } });
    // console panel is always dark → uses the DARK accent, theme-agnostic (base block)
    const base = css.slice(0, css.indexOf("@media"));
    expect(base).toContain("--rs-con-accent:#FF6A1F");
    // and not re-emitted per mode
    expect(css.slice(css.indexOf('data-theme="dark"'))).not.toContain("--rs-con-accent");
  });

  it("rejects a font value that tries to break out or inject a url()", () => {
    expect(themeToCss({ fontHeading: "Inter;}body{x:1" })).toBe("");
    expect(themeToCss({ fontHeading: "url(evil)" })).toBe("");
  });
});
