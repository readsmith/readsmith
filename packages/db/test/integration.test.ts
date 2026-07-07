import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type Db, DbError, createDb } from "../src/client.js";
import type { DbConfig } from "../src/config.js";
import { createJobRunner, defineJob } from "../src/jobs.js";
import { runMigrations } from "../src/migrate.js";
import {
  findSpecByHash,
  getSite,
  insertEndpoints,
  insertSpec,
  listEndpointsBySpec,
  searchEndpoints,
  upsertSite,
} from "../src/repos.js";
import { sql } from "../src/sql.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;

const config = (): DbConfig => ({
  databaseUrl: DATABASE_URL ?? "",
  storageRoot: ".rs-test",
  workerConcurrency: 2,
  logLevel: "error",
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 10000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await sleep(100);
  }
}

// Runs only when a disposable Postgres is available (TEST_DATABASE_URL set).
describe.skipIf(!DATABASE_URL)("persistence backbone (integration)", () => {
  let db: Db;

  beforeAll(async () => {
    db = createDb(config());
    await runMigrations(db);
  });

  afterAll(async () => {
    await db?.close();
  });

  // MG-2, MG-3, AC-2 (idempotency half).
  it("applies migrations and is idempotent on a second run", async () => {
    const again = await runMigrations(db);
    expect(again).toEqual([]);
    const tables = await db.query<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'app' ORDER BY table_name`);
    const names = tables.map((t) => t.table_name);
    expect(names).toContain("api_specs");
    expect(names).toContain("api_endpoints");
    expect(names).toContain("sites");
  });

  // DB-1, AC-3: pgvector is enabled and usable (proves M3-readiness).
  it("has pgvector available", async () => {
    const row = await db.one<{ v: string }>(sql`SELECT '[1,2,3]'::vector AS v`);
    expect(row?.v).toBe("[1,2,3]");
  });

  // DA-1, DA-3, AC-4: round-trip + Zod-validated reads.
  it("round-trips a site and validates the row", async () => {
    const site = await upsertSite(db, { id: "default", name: "Readsmith" });
    expect(site.id).toBe("default");
    const fetched = await getSite(db, "default");
    expect(fetched?.name).toBe("Readsmith");
    expect(fetched?.created_at).toBeInstanceOf(Date);
  });

  // §5 versioning + idempotency short-circuit.
  it("versions specs per source path and short-circuits identical content", async () => {
    const v1 = await insertSpec(db, {
      id: "spec-a-1",
      siteId: "default",
      sourcePath: "openapi.yaml",
      contentHash: "hash-1",
      rawRef: null,
      bundledRef: null,
      normalizedRef: null,
      info: { title: "Pets" },
    });
    expect(v1.version).toBe(1);

    // Same hash, different id -> returns the existing row, no new version.
    const same = await insertSpec(db, {
      id: "spec-a-1-dup",
      siteId: "default",
      sourcePath: "openapi.yaml",
      contentHash: "hash-1",
      rawRef: null,
      bundledRef: null,
      normalizedRef: null,
      info: { title: "Pets" },
    });
    expect(same.id).toBe("spec-a-1");
    expect(same.version).toBe(1);

    const v2 = await insertSpec(db, {
      id: "spec-a-2",
      siteId: "default",
      sourcePath: "openapi.yaml",
      contentHash: "hash-2",
      rawRef: null,
      bundledRef: null,
      normalizedRef: null,
      info: { title: "Pets v2" },
    });
    expect(v2.version).toBe(2);
    expect(
      await findSpecByHash(db, {
        siteId: "default",
        sourcePath: "openapi.yaml",
        contentHash: "hash-2",
      }),
    ).not.toBeNull();
  });

  // §5 unique index, AC-7: the DB rejects a duplicate idempotency key.
  it("rejects a duplicate (site, path, hash) at the database level", async () => {
    const insertRaw = (id: string) =>
      db.query(sql`
        INSERT INTO app.api_specs (id, site_id, source_path, content_hash, version)
        VALUES (${id}, 'default', 'dup.yaml', 'same-hash', ${1})`);
    await insertRaw("dup-1");
    await expect(insertRaw("dup-2")).rejects.toBeInstanceOf(DbError);
  });

  // Endpoints + FTS (the search half M3 augments with vectors).
  it("stores endpoints and full-text-searches them", async () => {
    await insertEndpoints(db, {
      specId: "spec-a-1",
      siteId: "default",
      endpoints: [
        {
          id: "op-list-users",
          operationId: "listUsers",
          method: "GET",
          path: "/users",
          tags: ["Users"],
          summary: "List users",
          deprecated: false,
          searchText: "list users GET /users",
        },
        {
          id: "op-create-order",
          operationId: "createOrder",
          method: "POST",
          path: "/orders",
          tags: ["Orders"],
          summary: "Create an order",
          deprecated: true,
          searchText: "create order POST /orders",
        },
      ],
    });

    const listed = await listEndpointsBySpec(db, "spec-a-1");
    expect(listed.map((e) => e.id).sort()).toEqual(["op-create-order", "op-list-users"]);
    expect(listed.find((e) => e.id === "op-create-order")?.deprecated).toBe(true);

    const hits = await searchEndpoints(db, { siteId: "default", query: "users" });
    expect(hits.map((h) => h.id)).toContain("op-list-users");
    expect(hits.map((h) => h.id)).not.toContain("op-create-order");
  });

  // JB-1/JB-2, AC-8 (happy path): enqueue -> validated consume runs once.
  it("runs an enqueued job through a validated handler", async () => {
    const runner = createJobRunner({ config: config() });
    const job = defineJob({ name: "test.echo", schema: z.object({ value: z.string() }) });
    const seen: string[] = [];
    await runner.start();
    await runner.work(job, async (data) => {
      seen.push(data.value);
    });
    await runner.enqueue(job, { value: "hello" });
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual(["hello"]);
    await runner.stop();
  }, 20000);

  // JB-3, AC-8 (singleton): a repeat enqueue under one key is deduplicated.
  it("deduplicates enqueues sharing a singleton key", async () => {
    const runner = createJobRunner({ config: config() });
    const job = defineJob({ name: "test.single", schema: z.object({ n: z.number() }) });
    await runner.start();
    // No worker registered, so both stay queued; the second is throttled to null.
    const first = await runner.enqueue(job, { n: 1 }, { singletonKey: "k" });
    const second = await runner.enqueue(job, { n: 2 }, { singletonKey: "k" });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    await runner.stop();
  }, 20000);

  // JB-4, AC-9: a throwing handler does not kill the worker.
  it("survives a failing job and keeps processing", async () => {
    const runner = createJobRunner({ config: config() });
    const failJob = defineJob({
      name: "test.fail",
      schema: z.object({}).passthrough(),
      retryLimit: 0,
    });
    const okJob = defineJob({ name: "test.ok", schema: z.object({ v: z.string() }) });
    const done: string[] = [];
    await runner.start();
    await runner.work(failJob, async () => {
      throw new Error("boom");
    });
    await runner.work(okJob, async (d) => {
      done.push(d.v);
    });
    await runner.enqueue(failJob, {});
    await runner.enqueue(okJob, { v: "still-alive" });
    await waitFor(() => done.includes("still-alive"));
    expect(done).toContain("still-alive");
    await runner.stop();
  }, 20000);
});
