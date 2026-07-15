import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RenderCache } from "@readsmith/mdx";
import { describe, expect, it } from "vitest";
import { compileSite } from "../src/compile.js";
import { type CompiledVersion, compileVersionedSite, siteVersionsOf } from "../src/versioned.js";

// Byte-for-byte identical source in both version trees, so any difference in the
// built bundles comes from the version prefix alone (the point of AC-4).
const INDEX = "# Home\n\nSee [Other](/other).\n";
const OTHER = "# Other\n\nBack [home](/).\n";

/** A repo with a default (v2 -> docs/) and a legacy (v1 -> versions/v1/) tree. */
async function twoVersionRepo(siteLines: string[] = []): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rs-ver-"));
  await writeFile(
    join(dir, "docs.yaml"),
    [
      "site:",
      "  name: Versioned",
      ...siteLines,
      "content:",
      "  root: docs",
      "versions:",
      "  default: v2",
      "  list:",
      "    - id: v2",
      "    - id: v1",
      "      content: versions/v1",
    ].join("\n"),
  );
  for (const root of ["docs", "versions/v1"]) {
    await mkdir(join(dir, root), { recursive: true });
    await writeFile(join(dir, root, "index.md"), INDEX);
    await writeFile(join(dir, root, "other.md"), OTHER);
  }
  return dir;
}

const byId = (versions: CompiledVersion[], id: string) =>
  versions.find((v) => v.id === id) as CompiledVersion;

const pageUrl = (v: CompiledVersion, slug: string) =>
  v.result.bundle.site.build.pages.find((p) => p.slug === slug)?.url;

const pageHtml = (v: CompiledVersion, slug: string) =>
  v.result.bundle.site.build.pages.find((p) => p.slug === slug)?.html ?? "";

describe("compileVersionedSite", () => {
  it("AC-1: two routable trees; default un-prefixed, non-default under /{id}; links stay in-version", async () => {
    const { default: def, versions } = await compileVersionedSite({
      contentDir: await twoVersionRepo(),
    });
    expect(def).toBe("v2");
    expect(versions.map((v) => v.id).sort()).toEqual(["v1", "v2"]);

    const v2 = byId(versions, "v2");
    expect(v2.isDefault).toBe(true);
    expect(pageUrl(v2, "")).toBe("/");
    expect(pageUrl(v2, "other")).toBe("/other");
    expect(pageHtml(v2, "")).toContain('href="/other"');

    const v1 = byId(versions, "v1");
    expect(v1.isDefault).toBe(false);
    expect(pageUrl(v1, "")).toBe("/v1");
    expect(pageUrl(v1, "other")).toBe("/v1/other");
    // The in-content absolute link resolves within v1, never above it.
    expect(pageHtml(v1, "")).toContain('href="/v1/other"');
    expect(pageHtml(v1, "")).not.toContain('href="/other"');
  });

  it("AC-2: composes with subpath hosting, order basePath -> version -> slug, once", async () => {
    const { versions } = await compileVersionedSite({
      contentDir: await twoVersionRepo(["  url: https://acme.dev/docs"]),
    });
    const v2 = byId(versions, "v2");
    expect(pageUrl(v2, "")).toBe("/docs");
    expect(pageUrl(v2, "other")).toBe("/docs/other");

    const v1 = byId(versions, "v1");
    expect(pageUrl(v1, "")).toBe("/docs/v1");
    expect(pageUrl(v1, "other")).toBe("/docs/v1/other");
    expect(pageHtml(v1, "")).toContain('href="/docs/v1/other"');
  });

  it("AC-3: a single-version site is byte-identical to a direct compileSite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rs-plain-"));
    await writeFile(join(dir, "docs.yaml"), "site:\n  name: Plain\ncontent:\n  root: docs\n");
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "index.md"), INDEX);
    await writeFile(join(dir, "docs", "other.md"), OTHER);

    const direct = await compileSite({ contentDir: dir });
    const { default: def, versions } = await compileVersionedSite({ contentDir: dir });
    expect(def).toBe("");
    expect(versions).toHaveLength(1);
    expect(versions[0]?.isDefault).toBe(true);
    expect(versions[0]?.result.bundleJson).toBe(direct.bundleJson);
    expect(versions[0]?.result.bundleHash).toBe(direct.bundleHash);
  });

  it("AC-4: identical source under different prefixes yields distinct hashes and no cache collision", async () => {
    // A shared render cache across versions: if the version prefix did not key
    // the cache, one version's baked links would leak into the other.
    const map = new Map();
    const renderCache: RenderCache = { get: (k) => map.get(k), set: (k, v) => map.set(k, v) };
    const { versions } = await compileVersionedSite({
      contentDir: await twoVersionRepo(),
      renderCache,
    });
    const v2 = byId(versions, "v2");
    const v1 = byId(versions, "v1");

    // Distinct content addresses even though the page source is byte-identical.
    expect(v1.result.bundleHash).not.toBe(v2.result.bundleHash);

    // Correct, un-crossed links despite sharing the cache.
    expect(pageHtml(v2, "")).toContain('href="/other"');
    expect(pageHtml(v1, "")).toContain('href="/v1/other"');
  });

  it("derives the routing manifest for multi-version, and null for single-version", async () => {
    const multi = await compileVersionedSite({ contentDir: await twoVersionRepo() });
    const manifest = siteVersionsOf(multi);
    expect(manifest?.default).toBe("v2");
    expect(
      manifest?.list.map((v) => ({ id: v.id, prefix: v.prefix, isDefault: v.isDefault })),
    ).toEqual([
      { id: "v2", prefix: "", isDefault: true },
      { id: "v1", prefix: "/v1", isDefault: false },
    ]);
    // Each version's non-hidden page slugs ride in the manifest for the selector.
    for (const v of manifest?.list ?? []) {
      expect(new Set(v.slugs)).toEqual(new Set(["", "other"]));
    }

    const dir = await mkdtemp(join(tmpdir(), "rs-plain-manifest-"));
    await writeFile(join(dir, "docs.yaml"), "site:\n  name: Plain\ncontent:\n  root: docs\n");
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "index.md"), INDEX);
    const single = await compileVersionedSite({ contentDir: dir });
    expect(siteVersionsOf(single)).toBeNull();
  });
});
