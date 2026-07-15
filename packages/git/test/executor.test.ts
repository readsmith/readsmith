import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash } from "@readsmith/model";
import { type BundleStore, createBundleStore } from "@readsmith/storage";
import { beforeEach, describe, expect, it } from "vitest";
import { createInProcessExecutor } from "../src/executor.js";
import type { GitProvider } from "../src/provider.js";
import { siteVersionsKey } from "../src/site-build.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "repo");

/** A provider that "fetches" by copying the fixture tree; records its destDir. */
function fixtureProvider(): GitProvider & { lastDest: string | null } {
  const provider = {
    lastDest: null as string | null,
    async fetchAtRef(_target: { repo: string; commitSha: string }, destDir: string) {
      provider.lastDest = destDir;
      await cp(FIXTURE, destDir, { recursive: true });
    },
  };
  return provider;
}

describe("InProcessExecutor", () => {
  let store: BundleStore;

  beforeEach(async () => {
    store = createBundleStore({
      driver: "local",
      root: await mkdtemp(join(tmpdir(), "rs-store-")),
    });
  });

  const job = {
    kind: "site.build" as const,
    siteId: "default",
    source: { repo: "acme/docs", commitSha: "abc123" },
    limits: { timeoutSec: 60 },
    artifact: { bundlePrefix: "bundles/" },
  };

  it("fetches, compiles, and writes a content-addressed artifact", async () => {
    const provider = fixtureProvider();
    const executor = createInProcessExecutor({ provider, store });
    const result = await executor.run(job);
    expect(result.ok).toBe(true);
    expect(result.pageCount).toBe(2);
    expect(result.bundleKey).toBe(`bundles/${result.bundleHash}.json`);
    const stored = await store.get(result.bundleKey ?? "");
    expect(stored).not.toBeNull();
    expect(contentHash(stored?.toString("utf8") ?? "")).toBe(result.bundleHash);
  });

  it("a single-version site produces one 'current' lane and no manifest", async () => {
    const result = await createInProcessExecutor({ provider: fixtureProvider(), store }).run(job);
    expect(result.versions).toHaveLength(1);
    expect(result.versions[0]?.versionId).toBe("current");
    expect(result.defaultVersionId).toBe("current");
    expect(result.manifest).toBeNull();
  });

  it("a multi-version site writes one bundle per lane and returns the manifest (unstored)", async () => {
    const multi: GitProvider = {
      async fetchAtRef(_t, destDir) {
        await writeFile(
          join(destDir, "docs.yaml"),
          [
            "site:",
            "  name: Versioned",
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
          await mkdir(join(destDir, root), { recursive: true });
          await writeFile(join(destDir, root, "index.md"), "# Home\n\nHi.\n");
        }
      },
    };
    const result = await createInProcessExecutor({ provider: multi, store }).run(job);
    expect(result.ok).toBe(true);
    expect(result.versions.map((v) => v.versionId).sort()).toEqual(["v1", "v2"]);
    expect(result.defaultVersionId).toBe("v2");

    const v2 = result.versions.find((v) => v.versionId === "v2");
    const v1 = result.versions.find((v) => v.versionId === "v1");
    // Distinct content addresses; both artifacts actually stored.
    expect(v1?.bundleHash).not.toBe(v2?.bundleHash);
    expect(await store.get(v2?.bundleKey ?? "")).not.toBeNull();
    expect(await store.get(v1?.bundleKey ?? "")).not.toBeNull();
    // Top-level fields are the default (v2) version's (back-compat).
    expect(result.bundleKey).toBe(v2?.bundleKey);

    // The manifest is returned for the dispatcher, not stored by the executor
    // (the dispatcher writes it only after every lane is published).
    expect(result.manifest?.default).toBe("v2");
    expect(result.manifest?.list.map((v) => v.id)).toEqual(["v2", "v1"]);
    expect(await store.get(siteVersionsKey(job.siteId))).toBeNull();
  });

  it("always deletes the ephemeral checkout, on success and on failure", async () => {
    const provider = fixtureProvider();
    const executor = createInProcessExecutor({ provider, store });
    await executor.run(job);
    expect(provider.lastDest).not.toBeNull();
    expect(existsSync(provider.lastDest ?? "")).toBe(false);

    const failing: GitProvider & { lastDest: string | null } = {
      lastDest: null,
      async fetchAtRef(_t, destDir) {
        failing.lastDest = destDir;
        throw new Error("clone denied");
      },
    };
    const result = await createInProcessExecutor({ provider: failing, store }).run(job);
    expect(result.ok).toBe(false);
    expect(existsSync(failing.lastDest ?? "")).toBe(false);
  });

  it("reports a fetch failure as a diagnostic result, never a throw", async () => {
    const provider: GitProvider = {
      async fetchAtRef() {
        throw new Error("repository not found");
      },
    };
    const result = await createInProcessExecutor({ provider, store }).run(job);
    expect(result.ok).toBe(false);
    expect(result.bundleKey).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "build-failed", severity: "error" }),
    ]);
    expect(await store.list()).toEqual([]);
  });

  it("times out a build that exceeds its budget", async () => {
    const provider: GitProvider = {
      async fetchAtRef() {
        await new Promise((r) => setTimeout(r, 500));
      },
    };
    const executor = createInProcessExecutor({ provider, store });
    const result = await executor.run({ ...job, limits: { timeoutSec: 0.1 } });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.message).toContain("timed out");
  });
});

describe("InProcessExecutor render cache", () => {
  it("persists renders across executor runs through the store", async () => {
    const store = createBundleStore({
      driver: "local",
      root: await mkdtemp(join(tmpdir(), "rs-cache-")),
    });
    const job = {
      kind: "site.build" as const,
      siteId: "default",
      source: { repo: "acme/docs", commitSha: "c1" },
      limits: { timeoutSec: 60 },
      artifact: { bundlePrefix: "bundles/" },
    };
    const executor = createInProcessExecutor({ provider: fixtureProvider(), store });
    const cold = await executor.run(job);
    expect(cold.rendered).toBe(cold.pageCount);

    // A fresh executor run (new scratch dir, same store): everything cached.
    const warm = await executor.run({ ...job, source: { ...job.source, commitSha: "c2" } });
    expect(warm.rendered).toBe(0);
    expect(warm.bundleKey).toBe(cold.bundleKey); // identical content dedupes
  });
});
