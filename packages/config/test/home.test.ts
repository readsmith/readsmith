import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/resolve.js";
import { slugFromPath } from "../src/slug.js";

const fixtures = join(import.meta.dirname, "fixtures");

/**
 * A repository's README is its front page. The slug rules already say so (an
 * `index` or `readme` file maps to its directory), but discovery cannot reach
 * above the content root, which is exactly where every repository keeps it.
 * `content.home` closes that gap without asking anyone to move or copy a file.
 */
describe("slugFromPath: readme is already a directory index", () => {
  it("maps README and index to their directory", () => {
    expect(slugFromPath("README.md")).toBe("");
    expect(slugFromPath("index.md")).toBe("");
    expect(slugFromPath("guide/README.md")).toBe("guide");
    expect(slugFromPath("guide/setup.md")).toBe("guide/setup");
  });
});

describe("content.home", () => {
  it("promotes a file above the content root to the site root", async () => {
    const config = await resolveConfig(join(fixtures, "home-readme"));
    const home = config.pages.find((p) => p.slug === "");
    expect(home?.path).toBe("../README.md");
    expect(config.pages.map((p) => p.slug).sort()).toEqual(["", "cli"]);
    expect(config.diagnostics).toEqual([]);
  });

  it("places the home page first in auto-navigation, not inside a '..' group", async () => {
    const config = await resolveConfig(join(fixtures, "home-readme"));
    // Explicit navigation is absent here, so this is the auto tree.
    expect(config.nav[0]).toEqual({ type: "page", slug: "" });
    expect(JSON.stringify(config.nav)).not.toContain("..");
  });

  it("is addressable from navigation by its basename", async () => {
    const config = await resolveConfig(join(fixtures, "home-readme"));
    // buildLookup keys on basename, path-without-extension, and slug.
    expect(config.pages.some((p) => p.path === "../README.md" && p.slug === "")).toBe(true);
  });

  it("rejects a home that escapes the repository root", async () => {
    const config = await resolveConfig(join(fixtures, "home-escape"));
    expect(config.pages.some((p) => p.slug === "")).toBe(false);
    const err = config.diagnostics.find((d) => d.code === "content-home");
    expect(err?.severity).toBe("error");
    expect(err?.message).toContain("escapes the repository root");
  });

  it("ignores a home that is not markdown", async () => {
    const config = await resolveConfig(join(fixtures, "repo-shaped"));
    expect(config.content.home).toBeUndefined(); // not configured there
  });

  it("does nothing when unset", async () => {
    const config = await resolveConfig(join(fixtures, "minimal"));
    expect(config.diagnostics.filter((d) => d.code === "content-home")).toEqual([]);
  });
});
