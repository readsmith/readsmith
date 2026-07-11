import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { assetPlan, contentRootOf, resolveConfig } from "../src/resolve.js";
import { DEFAULT_EXCLUDE } from "../src/schema.js";

const fixtures = join(import.meta.dirname, "fixtures");
const repoShaped = join(fixtures, "repo-shaped");

/**
 * Items 4 and 5. The failure these guard against is not cosmetic: when the asset
 * copy and the content build disagreed about the content root, pointing Readsmith
 * at a repository published that repository's source tree.
 */
describe("assetPlan: only declared directories may be served", () => {
  // AC-4.3
  it("AC-4.3: the content root is resolved from the config, and shared", async () => {
    const config = await resolveConfig(repoShaped);
    expect(config.content.root).toBe("docs");
    // The one helper both the content build and the asset copy call.
    expect(contentRootOf(repoShaped, config)).toBe(join(repoShaped, "docs"));
    expect(assetPlan(repoShaped, config)[0]?.dir).toBe(contentRootOf(repoShaped, config));
  });

  // AC-4.1
  it("AC-4.1: plans the content root, then each declared mount", async () => {
    const config = await resolveConfig(repoShaped);
    const plan = assetPlan(repoShaped, config).map((e) => ({
      dir: relative(repoShaped, e.dir),
      prefix: e.prefix,
      skipContent: e.skipContent,
    }));
    expect(plan).toEqual([
      { dir: "docs", prefix: "", skipContent: true },
      { dir: "media", prefix: "media", skipContent: false },
    ]);
  });

  // AC-4.2: the whole point. Nothing at the repository root is reachable.
  it("AC-4.2: no plan entry contains the repository's source tree", async () => {
    const config = await resolveConfig(repoShaped);
    const dirs = assetPlan(repoShaped, config).map((e) => e.dir);
    for (const leaked of ["src", "pnpm-lock.yaml", "CLAUDE.md", "SECURITY.md"]) {
      const path = join(repoShaped, leaked);
      const covered = dirs.some((dir) => !relative(dir, path).startsWith(".."));
      expect(covered, `${leaked} must not sit under any published directory`).toBe(false);
    }
  });

  // AC-4.4
  it("AC-4.4: the plan is deterministic across resolutions", async () => {
    const a = assetPlan(repoShaped, await resolveConfig(repoShaped));
    const b = assetPlan(repoShaped, await resolveConfig(repoShaped));
    expect(a).toEqual(b);
  });
});

describe("resolveConfig: asset mounts", () => {
  // AC-5.2 (first half)
  it("AC-5.2: a mount escaping the content root is permitted", async () => {
    const config = await resolveConfig(repoShaped);
    expect(config.assets).toEqual([{ from: "../media", to: "media" }]);
    expect(config.diagnostics).toEqual([]);
  });

  // AC-5.2 (second half)
  it("AC-5.2: a mount escaping the repository root is rejected with a diagnostic", async () => {
    const config = await resolveConfig(join(fixtures, "escape-repo"));
    expect(config.assets).toEqual([{ from: "../media", to: "media" }]); // the valid one survives
    const errs = config.diagnostics.filter((d) => d.code === "asset-mount");
    expect(errs).toHaveLength(1);
    expect(errs[0]?.severity).toBe("error");
    expect(errs[0]?.message).toContain("escapes the repository root");
  });

  it("defaults to no mounts", async () => {
    const config = await resolveConfig(join(fixtures, "minimal"));
    expect(config.assets).toEqual([]);
  });
});

describe("resolveConfig: links", () => {
  it("normalizes the repo URL and defaults the branch", async () => {
    const config = await resolveConfig(repoShaped);
    expect(config.links).toEqual({ repo: "https://github.com/acme/widget", branch: "main" });
  });

  it("leaves repo undefined when unset", async () => {
    const config = await resolveConfig(join(fixtures, "minimal"));
    expect(config.links.repo).toBeUndefined();
    expect(config.links.branch).toBe("main");
  });
});

/** Item 10, problem A. */
describe("resolveConfig: content.exclude merges with the defaults", () => {
  // AC-10.1
  it("AC-10.1: a user exclude does not disable the node_modules guard", async () => {
    const config = await resolveConfig(join(fixtures, "exclude-merge"));
    for (const pattern of DEFAULT_EXCLUDE) expect(config.content.exclude).toContain(pattern);
    expect(config.content.exclude).toContain("SECURITY.md");

    const slugs = config.pages.map((p) => p.slug).sort();
    expect(slugs).toEqual([""]); // index only
    expect(slugs.some((s) => s.includes("node_modules"))).toBe(false);
  });

  // AC-10.2
  it("AC-10.2: both a default and a user pattern are honored", async () => {
    const config = await resolveConfig(join(fixtures, "exclude-merge"));
    const paths = config.pages.map((p) => p.path);
    expect(paths).not.toContain("SECURITY.md");
    expect(paths).not.toContain("node_modules/pkg/readme.md");
  });

  it("applies the defaults when the user sets no exclude", async () => {
    const config = await resolveConfig(join(fixtures, "minimal"));
    expect(config.content.exclude).toEqual(DEFAULT_EXCLUDE);
  });
});

/** A repository checkout: docs root, root-level files never become pages. */
describe("resolveConfig: a repository-shaped checkout", () => {
  it("discovers only the docs tree, never CLAUDE.md or SECURITY.md", async () => {
    const config = await resolveConfig(repoShaped);
    expect(config.pages.map((p) => p.slug).sort()).toEqual(["", "cli", "policy"]);
  });
});

// Spec readsmith-docs (slice 2 platform fix): snippets/ is reserved for
// <Snippet> sources and never discovered as pages.
describe("snippets/ is reserved from page discovery", () => {
  it("excludes snippets/** by default", async () => {
    const config = await resolveConfig(join(fixtures, "snippets-reserved"));
    const slugs = config.pages.map((p) => p.slug);
    expect(slugs).toEqual([""]);
    expect(config.content.exclude).toContain("snippets/**");
  });
});
