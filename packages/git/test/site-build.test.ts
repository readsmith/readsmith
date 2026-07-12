import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Db,
  createDb,
  getCurrentDeployment,
  listDeployments,
  repointCurrent,
  runMigrations,
  sql,
  upsertSite,
} from "@readsmith/db";
import { type BundleStore, createBundleStore } from "@readsmith/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Executor, createInProcessExecutor } from "../src/executor.js";
import type { GitProvider } from "../src/provider.js";
import { createCurrentBundleLoader } from "../src/resolve.js";
import { runSiteBuild } from "../src/site-build.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const FIXTURE = join(import.meta.dirname, "fixtures", "repo");

const provider: GitProvider = {
  async fetchAtRef(_target, destDir) {
    await cp(FIXTURE, destDir, { recursive: true });
  },
};

/** An executor whose completion the test controls (for the supersede race). */
function gatedExecutor(inner: Executor): Executor & { release: () => void } {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    release: () => open(),
    async run(job) {
      await gate;
      return inner.run(job);
    },
  };
}

describe.skipIf(!DATABASE_URL)("site.build orchestration (integration)", () => {
  const SITE = "build-test";
  let db: Db;
  let store: BundleStore;

  beforeAll(async () => {
    db = createDb({
      databaseUrl: DATABASE_URL ?? "",
      storageRoot: ".rs-test",
      workerConcurrency: 2,
      logLevel: "error",
    });
    await runMigrations(db);
    await upsertSite(db, { id: SITE, name: "Build Test" });
    // Idempotent across runs on a persistent test database.
    await db.query(sql`DELETE FROM app.deployments WHERE site_id = ${SITE}`);
    store = createBundleStore({ driver: "local", root: await mkdtemp(join(tmpdir(), "rs-art-")) });
  });

  afterAll(async () => {
    await db?.close();
  });

  const payload = (sha: string) => ({
    siteId: SITE,
    repo: "acme/docs",
    ref: "refs/heads/main",
    commitSha: sha,
  });

  it("builds, verifies, publishes atomically, and fires the flip hook", async () => {
    const flips: string[] = [];
    const executor = createInProcessExecutor({ provider, store });
    const row = await runSiteBuild(
      { db, store, executor, afterFlip: (d) => void flips.push(d.id) },
      payload("sha-1"),
    );
    expect(row.status).toBe("ready");
    expect(row.is_current).toBe(true);
    expect(row.bundle_ref).toMatch(/^bundles\/.+\.json$/);
    expect(flips).toEqual([row.id]);
    expect(await store.has(row.bundle_ref ?? "")).toBe(true);
    expect((await getCurrentDeployment(db, { siteId: SITE }))?.id).toBe(row.id);
  });

  it("dedupes identical content to the same artifact ref across deployments", async () => {
    const executor = createInProcessExecutor({ provider, store });
    const first = await getCurrentDeployment(db, { siteId: SITE });
    const row = await runSiteBuild({ db, store, executor }, payload("sha-2"));
    expect(row.is_current).toBe(true);
    expect(row.bundle_ref).toBe(first?.bundle_ref);
  });

  it("fails a build whose stored artifact does not hash to the claim, and never flips", async () => {
    const before = await getCurrentDeployment(db, { siteId: SITE });
    const lying: Executor = {
      async run(job) {
        const key = `${job.artifact.bundlePrefix}forged.json`;
        await store.put(key, '{"site":"forged"}');
        return {
          ok: true,
          bundleKey: key,
          bundleHash: "not-the-real-hash",
          pageCount: 1,
          rendered: 1,
          diagnostics: [],
          usage: { wallMs: 1 },
        };
      },
    };
    const row = await runSiteBuild({ db, store, executor: lying }, payload("sha-forged"));
    expect(row.status).toBe("failed");
    expect((await getCurrentDeployment(db, { siteId: SITE }))?.id).toBe(before?.id);
  });

  it("supersede race: an older build finishing late never flips the pointer backward", async () => {
    const inner = createInProcessExecutor({ provider, store });
    const gated = gatedExecutor(inner);
    // The older build starts first (lower build_seq) but is held open.
    const older = runSiteBuild({ db, store, executor: gated }, payload("sha-slow"));
    await new Promise((r) => setTimeout(r, 50)); // let it insert its row
    const newer = await runSiteBuild({ db, store, executor: inner }, payload("sha-fast"));
    expect(newer.is_current).toBe(true);
    gated.release();
    const late = await older;
    expect(late.status).toBe("superseded");
    expect(late.is_current).toBe(false);
    expect((await getCurrentDeployment(db, { siteId: SITE }))?.id).toBe(newer.id);
  });

  it("rollback repoints and the loader follows after its TTL", async () => {
    let clock = 0;
    const loader = createCurrentBundleLoader({
      db,
      store,
      siteId: SITE,
      ttlMs: 1000,
      now: () => clock,
    });
    // Build changed content so this deployment's artifact ref actually differs.
    const changedProvider: GitProvider = {
      async fetchAtRef(_target, destDir) {
        await cp(FIXTURE, destDir, { recursive: true });
        await writeFile(join(destDir, "changelog.md"), "# Changelog\n\nA new page.\n");
      },
    };
    const executor = createInProcessExecutor({ provider: changedProvider, store });
    const current = await runSiteBuild({ db, store, executor }, payload("sha-roll"));
    expect(current.is_current).toBe(true);
    const served = await loader.load();
    expect(served?.ref).toBe(current.bundle_ref);

    // Repoint to the first (unchanged-content) deployment of this run.
    const prior = await repointCurrent(db, { siteId: SITE, deploymentId: `dep:${SITE}:1` });
    expect(prior.bundle_ref).not.toBe(current.bundle_ref);
    // Within the TTL the loader still serves the cached pointer...
    expect((await loader.load())?.ref).toBe(current.bundle_ref);
    // ...and re-resolves once it expires (or is invalidated).
    clock += 1001;
    expect((await loader.load())?.ref).toBe(prior.bundle_ref);
  });

  it("loader returns null when no deployment exists (local-bundle fallback)", async () => {
    await upsertSite(db, { id: "empty-site", name: "Empty" });
    const loader = createCurrentBundleLoader({ db, store, siteId: "empty-site" });
    expect(await loader.load()).toBeNull();
  });
});

describe.skipIf(!DATABASE_URL)("retention (integration)", () => {
  const SITE = "retain-test";
  let db: Db;
  let store: BundleStore;

  beforeAll(async () => {
    db = createDb({
      databaseUrl: DATABASE_URL ?? "",
      storageRoot: ".rs-test",
      workerConcurrency: 2,
      logLevel: "error",
    });
    await runMigrations(db);
    await upsertSite(db, { id: SITE, name: "Retain Test" });
    await db.query(sql`DELETE FROM app.deployments WHERE site_id = ${SITE}`);
    store = createBundleStore({ driver: "local", root: await mkdtemp(join(tmpdir(), "rs-ret-")) });
  });

  afterAll(async () => {
    await db?.close();
  });

  it("prunes old snapshots and deletes unshared artifacts, never the current one", async () => {
    // Three deployments with distinct content (distinct artifact refs). Each
    // ships one shared asset (same bytes in every build) and one unique to
    // the build, so asset GC has both a survivor and a casualty to prove.
    const providerFor = (marker: string): GitProvider => ({
      async fetchAtRef(_t, destDir) {
        await cp(FIXTURE, destDir, { recursive: true });
        await writeFile(join(destDir, "extra.md"), `# Extra\n\n${marker}\n`);
        await writeFile(join(destDir, "shared.svg"), "<svg><title>shared</title></svg>");
        await writeFile(join(destDir, "only.svg"), `<svg><title>${marker}</title></svg>`);
      },
    });
    const refs: string[] = [];
    for (const marker of ["one", "two", "three"]) {
      const executor = createInProcessExecutor({ provider: providerFor(marker), store });
      const row = await runSiteBuild(
        { db, store, executor, retention: { keepLast: 1 } },
        { siteId: SITE, repo: "acme/docs", ref: "refs/heads/main", commitSha: `ret-${marker}` },
      );
      expect(row.is_current).toBe(true);
      refs.push(row.bundle_ref ?? "");
    }
    // keepLast=1: the first snapshot is pruned and its artifact removed; the
    // second survives as rollback history; the third is current.
    expect(await store.has(refs[0] ?? "")).toBe(false);
    expect(await store.has(refs[1] ?? "")).toBe(true);
    expect(await store.has(refs[2] ?? "")).toBe(true);
    const history = await listDeployments(db, { siteId: SITE, limit: 10 });
    expect(history.find((d) => d.bundle_ref === refs[0])?.status).toBe("pruned");
    expect((await getCurrentDeployment(db, { siteId: SITE }))?.bundle_ref).toBe(refs[2]);

    // Asset GC: the pruned build's unique asset is gone, the asset shared by
    // every build survives, and the retained builds' assets are untouched.
    const storedAssets = await store.list(`sites/${SITE}/assets/`);
    const manifestOf = async (ref: string) => {
      const parsed = JSON.parse((await store.get(ref))?.toString("utf8") ?? "{}") as {
        site?: { assets?: Record<string, { key: string }> };
      };
      return parsed.site?.assets ?? {};
    };
    const retainedKeys = new Set<string>();
    for (const ref of [refs[1] ?? "", refs[2] ?? ""]) {
      for (const entry of Object.values(await manifestOf(ref))) retainedKeys.add(entry.key);
    }
    // Everything retained bundles reference is still stored...
    for (const key of retainedKeys) expect(storedAssets).toContain(key);
    // ...and nothing else is: the pruned build's unique asset was collected.
    expect(new Set(storedAssets)).toEqual(retainedKeys);
  });
});

describe.skipIf(!DATABASE_URL)("failOnError (integration)", () => {
  const SITE = "strict-test";
  let db: Db;
  let store: BundleStore;

  const brokenProvider: GitProvider = {
    async fetchAtRef(_t, destDir) {
      await cp(FIXTURE, destDir, { recursive: true });
      await writeFile(join(destDir, "broken.mdx"), "# Broken\n\n<Unclosed\n");
    },
  };

  beforeAll(async () => {
    db = createDb({
      databaseUrl: DATABASE_URL ?? "",
      storageRoot: ".rs-test",
      workerConcurrency: 2,
      logLevel: "error",
    });
    await runMigrations(db);
    await upsertSite(db, { id: SITE, name: "Strict Test" });
    await db.query(sql`DELETE FROM app.deployments WHERE site_id = ${SITE}`);
    store = createBundleStore({ driver: "local", root: await mkdtemp(join(tmpdir(), "rs-str-")) });
  });

  afterAll(async () => {
    await db?.close();
  });

  const payload = (sha: string) => ({
    siteId: SITE,
    repo: "acme/docs",
    ref: "refs/heads/main",
    commitSha: sha,
  });

  it("default: a broken page publishes with diagnostics", async () => {
    const executor = createInProcessExecutor({ provider: brokenProvider, store });
    const row = await runSiteBuild({ db, store, executor }, payload("strict-sha-1"));
    expect(row.status).toBe("ready");
    expect(row.is_current).toBe(true);
  });

  it("strict: a broken page fails the build and never moves the pointer", async () => {
    const before = await getCurrentDeployment(db, { siteId: SITE });
    const executor = createInProcessExecutor({ provider: brokenProvider, store });
    const row = await runSiteBuild(
      { db, store, executor, failOnError: true },
      payload("strict-sha-2"),
    );
    expect(row.status).toBe("failed");
    expect(row.is_current).toBe(false);
    expect((await getCurrentDeployment(db, { siteId: SITE }))?.id).toBe(before?.id);
    // Healthy content under the same strict flag still publishes.
    const healthy = createInProcessExecutor({ provider, store });
    const fixed = await runSiteBuild(
      { db, store, executor: healthy, failOnError: true },
      payload("strict-sha-3"),
    );
    expect(fixed.status).toBe("ready");
    expect(fixed.is_current).toBe(true);
  });
});
