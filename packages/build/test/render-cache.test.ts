import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BundleStore, createBundleStore } from "@readsmith/storage";
import { beforeEach, describe, expect, it } from "vitest";
import { compileSite } from "../src/compile.js";
import { RENDER_CACHE_PREFIX, openRenderCache } from "../src/render-cache.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "site");

/** A mutable copy of the fixture under a fixed name (the name feeds the site title). */
async function copyOfFixture(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "rs-rc-"));
  const dir = join(parent, "site");
  await mkdir(dir);
  await cp(FIXTURE, dir, { recursive: true });
  return dir;
}

describe("persisted render cache", () => {
  let store: BundleStore;

  beforeEach(async () => {
    store = createBundleStore({ driver: "local", root: await mkdtemp(join(tmpdir(), "rs-rcs-")) });
  });

  it("warm builds are byte-identical to cold ones and render nothing", async () => {
    const dir = await copyOfFixture();
    const first = await openRenderCache(store);
    const cold = await compileSite({ contentDir: dir, renderCache: first.cache });
    expect(cold.rebuiltPages.length).toBe(2);
    expect(await first.flush()).toBeGreaterThan(0);
    expect((await store.list(RENDER_CACHE_PREFIX)).length).toBeGreaterThan(0);

    const second = await openRenderCache(store);
    const warm = await compileSite({ contentDir: dir, renderCache: second.cache });
    expect(warm.rebuiltPages).toEqual([]);
    expect(second.stats().hits).toBe(2);
    // The artifact must not remember cache state: same content, same bytes.
    expect(warm.bundleJson).toBe(cold.bundleJson);
    expect(warm.bundleHash).toBe(cold.bundleHash);
    expect(warm.bundle.site.build.rebuilt).toEqual([]);
  });

  it("an unrelated edit re-renders exactly its own page", async () => {
    const dir = await copyOfFixture();
    const first = await openRenderCache(store);
    await compileSite({ contentDir: dir, renderCache: first.cache });
    await first.flush();

    await writeFile(join(dir, "index.md"), "# Welcome\n\nEdited landing copy.\n");
    const second = await openRenderCache(store);
    const edited = await compileSite({ contentDir: dir, renderCache: second.cache });
    expect(edited.rebuiltPages).toEqual(["index.md"]);
  });

  it("a shared-snippet edit re-renders every dependent page and only those", async () => {
    const dir = await copyOfFixture();
    const first = await openRenderCache(store);
    await compileSite({ contentDir: dir, renderCache: first.cache });
    await first.flush();

    await writeFile(join(dir, "snippets", "note.md"), "A shared note, now revised.\n");
    const second = await openRenderCache(store);
    const edited = await compileSite({ contentDir: dir, renderCache: second.cache });
    // getting-started.mdx embeds the snippet; index.md does not.
    expect(edited.rebuiltPages).toEqual(["getting-started.mdx"]);
    expect(edited.bundleJson).toContain("A shared note, now revised.");
  });

  it("tolerates corrupt cache entries as misses", async () => {
    const dir = await copyOfFixture();
    const first = await openRenderCache(store);
    const cold = await compileSite({ contentDir: dir, renderCache: first.cache });
    await first.flush();
    const keys = await store.list(RENDER_CACHE_PREFIX);
    await store.put(keys[0] ?? "", "{not json");

    const second = await openRenderCache(store);
    const rebuilt = await compileSite({ contentDir: dir, renderCache: second.cache });
    expect(rebuilt.rebuiltPages.length).toBe(1); // only the corrupted entry's page
    expect(rebuilt.bundleJson).toBe(cold.bundleJson);
  });

  it("keys the cache by base path: a subpath change re-renders, never serves stale hrefs", async () => {
    const dir = await copyOfFixture();
    await writeFile(
      join(dir, "linked.md"),
      "# Linked\n\nGo read [Getting started](getting-started.mdx).\n",
    );
    const htmlOf = (r: Awaited<ReturnType<typeof compileSite>>) =>
      r.bundle.site.build.pages.find((p) => p.slug === "linked")?.html ?? "";
    const first = await openRenderCache(store);
    const rootPathed = await compileSite({ contentDir: dir, renderCache: first.cache });
    expect(htmlOf(rootPathed)).toContain('href="/getting-started"');
    await first.flush();

    // The site moves under a subpath; sources are byte-identical.
    await writeFile(join(dir, "docs.yaml"), "site:\n  name: site\n  url: https://x.dev/help\n");
    const second = await openRenderCache(store);
    const subPathed = await compileSite({ contentDir: dir, renderCache: second.cache });
    expect(subPathed.rebuiltPages.length).toBeGreaterThan(0); // keys changed, no stale hits
    expect(htmlOf(subPathed)).toContain('href="/help/getting-started"');
    expect(htmlOf(subPathed)).not.toContain('href="/getting-started"');
  });
});
