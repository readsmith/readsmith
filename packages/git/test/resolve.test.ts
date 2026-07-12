import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Db,
  createDb,
  insertDeployment,
  publishDeployment,
  runMigrations,
  sql,
  upsertSite,
} from "@readsmith/db";
import { type BundleStore, createBundleStore } from "@readsmith/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDeploymentBundleSource, createStaticSiteResolver } from "../src/resolve.js";

describe("createStaticSiteResolver", () => {
  it("maps every host to the configured site, always active", () => {
    const resolver = createStaticSiteResolver();
    expect(resolver.resolve("docs.example.com")).toEqual({ siteId: "default", status: "active" });
    expect(resolver.resolve("anything:4321")).toEqual({ siteId: "default", status: "active" });
    expect(createStaticSiteResolver("acme").resolve("x")).toEqual({
      siteId: "acme",
      status: "active",
    });
  });
});

const DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!DATABASE_URL)("createDeploymentBundleSource (integration)", () => {
  let db: Db;
  let store: BundleStore;

  async function publish(siteId: string, content: string): Promise<string> {
    const ref = `bundles/${siteId}-${content}.json`;
    await store.put(ref, JSON.stringify({ site: siteId, content }));
    const row = await insertDeployment(db, {
      siteId,
      gitRef: "refs/heads/main",
      commitSha: `sha-${siteId}-${content}`,
    });
    await publishDeployment(db, { id: row.id, bundleRef: ref, bundleHash: `h-${content}` });
    return ref;
  }

  beforeAll(async () => {
    db = createDb({
      databaseUrl: DATABASE_URL ?? "",
      storageRoot: ".rs-test",
      workerConcurrency: 2,
      logLevel: "error",
    });
    await runMigrations(db);
    for (const site of ["multi-a", "multi-b", "multi-c"]) {
      await upsertSite(db, { id: site, name: site });
      await db.query(sql`DELETE FROM app.deployments WHERE site_id = ${site}`);
    }
    store = createBundleStore({ driver: "local", root: await mkdtemp(join(tmpdir(), "rs-ms-")) });
  });

  afterAll(async () => {
    await db?.close();
  });

  it("serves each site its own current deployment, independently", async () => {
    await publish("multi-a", "one");
    await publish("multi-b", "uno");
    const source = createDeploymentBundleSource({ db, store });
    expect(JSON.parse((await source.load("multi-a"))?.json ?? "{}").site).toBe("multi-a");
    expect(JSON.parse((await source.load("multi-b"))?.json ?? "{}").site).toBe("multi-b");
    expect(await source.load("multi-c")).toBeNull(); // no deployment yet
  });

  it("invalidates one site without touching the others", async () => {
    let clock = 0;
    const source = createDeploymentBundleSource({ db, store, ttlMs: 60_000, now: () => clock });
    const aBefore = (await source.load("multi-a"))?.ref;
    await source.load("multi-b");
    const aRef = await publish("multi-a", "two");
    // Both cached within TTL; only the invalidated site re-resolves.
    expect((await source.load("multi-a"))?.ref).toBe(aBefore);
    source.invalidate("multi-a");
    expect((await source.load("multi-a"))?.ref).toBe(aRef);
    expect(JSON.parse((await source.load("multi-b"))?.json ?? "{}").site).toBe("multi-b");
    clock += 1; // no TTL expiry needed for the invalidated path
  });

  it("caps live loaders and re-resolves evicted sites correctly", async () => {
    await publish("multi-c", "tres");
    const source = createDeploymentBundleSource({ db, store, maxSites: 2 });
    expect(await source.load("multi-a")).not.toBeNull();
    expect(await source.load("multi-b")).not.toBeNull();
    expect(await source.load("multi-c")).not.toBeNull(); // evicts multi-a
    // Evicted site still serves, through a fresh loader.
    expect(JSON.parse((await source.load("multi-a"))?.json ?? "{}").site).toBe("multi-a");
  });
});
