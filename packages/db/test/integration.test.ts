import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type Db, DbError, createDb } from "../src/client.js";
import type { DbConfig } from "../src/config.js";
import { createJobRunner, defineJob } from "../src/jobs.js";
import { runMigrations } from "../src/migrate.js";
import {
  deleteChunksNotIn,
  findSpecByHash,
  ftsSearchChunks,
  getCurrentDeployment,
  getGitConnection,
  getSite,
  insertAiQuery,
  insertDeployment,
  insertEndpoints,
  insertSpec,
  listChunkHashes,
  listDeployments,
  listEndpointsBySpec,
  markDeploymentFailed,
  pruneSuperseded,
  publishDeployment,
  purgeAiQueries,
  repointCurrent,
  searchEndpoints,
  setAiQueryFeedback,
  setLastSyncedSha,
  upsertDocChunks,
  upsertGitConnection,
  upsertSite,
  vectorSearchChunks,
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

  // M3 (0002): the doc-chunk index. Proves halfvec DDL, null-embedding rows, the
  // incremental-diff basis, idempotent upsert, and removed-page pruning.
  it("indexes doc_chunks (halfvec + null embedding), lists hashes, upserts idempotently", async () => {
    await upsertSite(db, { id: "default", name: "Readsmith" });
    const emb = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    const n = await upsertDocChunks(db, {
      siteId: "default",
      chunks: [
        {
          id: "dc1",
          kind: "doc",
          endpointId: null,
          pageId: "p1",
          path: "/a",
          headerPath: ["A"],
          anchor: "a",
          method: null,
          versionId: "current",
          locale: "en",
          contentHash: "h1",
          text: "hello world",
          embedding: emb,
        },
        {
          id: "dc2",
          kind: "doc",
          endpointId: null,
          pageId: "p2",
          path: "/b",
          headerPath: [],
          anchor: null,
          method: null,
          versionId: "current",
          locale: "en",
          contentHash: "h2",
          text: "no vector here",
          embedding: null,
        },
      ],
    });
    expect(n).toBe(2);

    const hashes = (await listChunkHashes(db, { siteId: "default" })).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    expect(hashes).toEqual([
      { id: "dc1", contentHash: "h1" },
      { id: "dc2", contentHash: "h2" },
    ]);

    // Re-upsert dc1 with a new hash: overwrite in place, not a duplicate row.
    await upsertDocChunks(db, {
      siteId: "default",
      chunks: [
        {
          id: "dc1",
          kind: "doc",
          endpointId: null,
          pageId: "p1",
          path: "/a",
          headerPath: ["A"],
          anchor: "a",
          method: null,
          versionId: "current",
          locale: "en",
          contentHash: "h1b",
          text: "hello world v2",
          embedding: emb,
        },
      ],
    });
    const after = await listChunkHashes(db, { siteId: "default" });
    expect(after.length).toBe(2);
    expect(after.find((h) => h.id === "dc1")?.contentHash).toBe("h1b");
  });

  it("prunes chunks not in the current set", async () => {
    const deleted = await deleteChunksNotIn(db, { siteId: "default", keepIds: ["dc1"] });
    expect(deleted).toBe(1); // dc2 removed
    const remaining = await listChunkHashes(db, { siteId: "default" });
    expect(remaining.map((h) => h.id)).toEqual(["dc1"]);
  });

  // M3 (0002): the Ask-AI query log + retention purge. Model ids stored, no key.
  it("logs an ai_query, records feedback, and purges by retention", async () => {
    const q = await insertAiQuery(db, {
      id: "q1",
      siteId: "default",
      query: "how do i set up",
      filters: { version: "current", locale: "en" },
      retrievedChunkIds: ["dc1"],
      answer: "Do X then Y.",
      citedIds: ["dc1"],
      model: { chat: "mock:chat", embedding: "mock:embed" },
      inputTokens: 1500,
      outputTokens: 300,
      costEstimate: 0.004,
      latencyMs: 120,
    });
    expect(q.cited_ids).toEqual(["dc1"]);
    expect(q.model).toEqual({ chat: "mock:chat", embedding: "mock:embed" });
    expect(q.input_tokens).toBe(1500);
    expect(q.output_tokens).toBe(300);
    expect(q.cost_estimate).toBeCloseTo(0.004);
    expect(q.feedback).toBeNull();

    await setAiQueryFeedback(db, { id: "q1", feedback: 1 });
    const kept = await purgeAiQueries(db, { olderThanDays: 90 });
    expect(kept).toBe(0); // a just-logged row is retained

    // Backdate past the window, then purge.
    await db.query(
      sql`UPDATE app.ai_queries SET created_at = now() - interval '100 days' WHERE id = ${"q1"}`,
    );
    const purged = await purgeAiQueries(db, { olderThanDays: 90 });
    expect(purged).toBe(1);
  });

  // M3 (Slice 4): the two retrieval arms. Proves halfvec cosine kNN, FTS, and
  // the version/locale hard-filter. Isolated under its own site.
  it("vector + FTS search rank by relevance and hard-filter by version/locale", async () => {
    const unit = (i: number): number[] => {
      const v = new Array<number>(1024).fill(0);
      v[i] = 1;
      return v;
    };
    await upsertSite(db, { id: "search-test", name: "S" });
    await upsertDocChunks(db, {
      siteId: "search-test",
      chunks: [
        {
          id: "sca",
          kind: "doc",
          endpointId: null,
          pageId: "pa",
          path: "/auth",
          headerPath: ["Authentication"],
          anchor: "auth",
          method: null,
          versionId: "current",
          locale: "en",
          contentHash: "sa",
          text: "authentication guide and access tokens",
          embedding: unit(0),
        },
        {
          id: "scb",
          kind: "doc",
          endpointId: null,
          pageId: "pb",
          path: "/billing",
          headerPath: ["Billing"],
          anchor: "bill",
          method: null,
          versionId: "current",
          locale: "en",
          contentHash: "sb",
          text: "billing overview and invoices",
          embedding: unit(1),
        },
        {
          id: "scc",
          kind: "doc",
          endpointId: null,
          pageId: "pc",
          path: "/auth-fr",
          headerPath: ["Auth"],
          anchor: "auth",
          method: null,
          versionId: "current",
          locale: "fr",
          contentHash: "sc",
          text: "authentication guide french",
          embedding: unit(0),
        },
      ],
    });

    const v = await vectorSearchChunks(db, {
      siteId: "search-test",
      versionId: "current",
      locale: "en",
      embedding: unit(0),
      limit: 10,
    });
    expect(v[0]?.id).toBe("sca"); // closest to the query vector
    expect(v.map((h) => h.id)).not.toContain("scc"); // fr filtered out

    const f = await ftsSearchChunks(db, {
      siteId: "search-test",
      versionId: "current",
      locale: "en",
      query: "authentication",
      limit: 10,
    });
    expect(f.map((h) => h.id)).toContain("sca");
    expect(f.map((h) => h.id)).not.toContain("scb"); // no keyword match
    expect(f.map((h) => h.id)).not.toContain("scc"); // fr filtered out
  });
});

// M2 migration 0003: git connections + deployments (DM-1..DM-4).
describe.skipIf(!DATABASE_URL)("git connections + deployments (integration)", () => {
  let db: Db;
  const SITE = "deploy-test";

  beforeAll(async () => {
    db = createDb(config());
    await runMigrations(db);
    await upsertSite(db, { id: SITE, name: "Deploy Test" });
    // Idempotent across runs on a persistent test database.
    await db.query(sql`DELETE FROM app.deployments WHERE site_id = ${SITE}`);
    await db.query(sql`DELETE FROM app.git_connections WHERE site_id = ${SITE}`);
  });

  afterAll(async () => {
    await db?.close();
  });

  const openDeployment = (sha: string) =>
    insertDeployment(db, { siteId: SITE, gitRef: "refs/heads/main", commitSha: sha });

  it("upserts a connection per (site, repo) and records the synced sha", async () => {
    const first = await upsertGitConnection(db, {
      id: "conn-1",
      siteId: SITE,
      provider: "github",
      installationId: null, // PAT mode: no installation
      repo: "acme/docs",
      branch: "main",
    });
    expect(first.installation_id).toBeNull();

    const rebound = await upsertGitConnection(db, {
      id: "conn-ignored", // conflict target keeps the original id
      siteId: SITE,
      provider: "github",
      installationId: "12345",
      repo: "acme/docs",
      branch: "docs",
    });
    expect(rebound.id).toBe("conn-1");
    expect(rebound.installation_id).toBe("12345");
    expect(rebound.branch).toBe("docs");

    await setLastSyncedSha(db, { id: "conn-1", sha: "abc123" });
    const fetched = await getGitConnection(db, SITE);
    expect(fetched?.last_synced_sha).toBe("abc123");
  });

  it("allocates a per-site monotonic build_seq and a deterministic id", async () => {
    const a = await openDeployment("sha-a");
    const b = await openDeployment("sha-b");
    expect(b.build_seq).toBe(a.build_seq + 1);
    expect(a.id).toBe(`dep:${SITE}:${a.build_seq}`);
    expect(a.status).toBe("building");
    expect(a.is_current).toBe(false);
  });

  it("publishes atomically: ready + current, and dedupes nothing away", async () => {
    const dep = await openDeployment("sha-pub");
    const { flipped, row } = await publishDeployment(db, {
      id: dep.id,
      bundleRef: "bundles/hash-pub.json",
      bundleHash: "hash-pub",
    });
    expect(flipped).toBe(true);
    expect(row.status).toBe("ready");
    expect(row.is_current).toBe(true);
    const current = await getCurrentDeployment(db, { siteId: SITE });
    expect(current?.id).toBe(dep.id);
  });

  it("supersede guard: a late-finishing older build can never flip the pointer backward", async () => {
    const older = await openDeployment("sha-old");
    const newer = await openDeployment("sha-new");
    // The newer build finishes and publishes first.
    await publishDeployment(db, {
      id: newer.id,
      bundleRef: "bundles/hash-new.json",
      bundleHash: "hash-new",
    });
    // The older build finishes late: it must land as superseded, not current.
    const { flipped, row } = await publishDeployment(db, {
      id: older.id,
      bundleRef: "bundles/hash-old.json",
      bundleHash: "hash-old",
    });
    expect(flipped).toBe(false);
    expect(row.status).toBe("superseded");
    const current = await getCurrentDeployment(db, { siteId: SITE });
    expect(current?.id).toBe(newer.id);
  });

  it("enforces one current deployment per (site, version) at the index level", async () => {
    await expect(
      db.query(sql`
        UPDATE app.deployments SET is_current = true
        WHERE site_id = ${SITE} AND NOT is_current AND status = 'superseded'`),
    ).rejects.toThrow();
  });

  it("rollback repoints to a prior ready deployment; unpublishable targets are rejected", async () => {
    const prior = await openDeployment("sha-prior");
    await publishDeployment(db, {
      id: prior.id,
      bundleRef: "bundles/hash-prior.json",
      bundleHash: "hash-prior",
    });
    const latest = await openDeployment("sha-latest");
    await publishDeployment(db, {
      id: latest.id,
      bundleRef: "bundles/hash-latest.json",
      bundleHash: "hash-latest",
    });
    expect((await getCurrentDeployment(db, { siteId: SITE }))?.id).toBe(latest.id);

    const rolled = await repointCurrent(db, { siteId: SITE, deploymentId: prior.id });
    expect(rolled.id).toBe(prior.id);
    expect(rolled.is_current).toBe(true);
    expect((await getCurrentDeployment(db, { siteId: SITE }))?.id).toBe(prior.id);

    // A failed build has no artifact: it can never become current.
    const failed = await openDeployment("sha-fail");
    await markDeploymentFailed(db, failed.id);
    await expect(repointCurrent(db, { siteId: SITE, deploymentId: failed.id })).rejects.toThrow(
      /not a publishable snapshot/,
    );
  });

  it("prunes old snapshots but never the current one, and keeps shared artifact refs", async () => {
    // A new deployment sharing the artifact of an old one (identical content dedupe).
    const shared = await openDeployment("sha-shared");
    await publishDeployment(db, {
      id: shared.id,
      bundleRef: "bundles/hash-pub.json", // same ref as the earlier sha-pub deployment
      bundleHash: "hash-pub",
    });

    const { prunedIds, unreferencedRefs } = await pruneSuperseded(db, {
      siteId: SITE,
      keepLast: 1,
    });
    expect(prunedIds.length).toBeGreaterThan(0);

    const current = await getCurrentDeployment(db, { siteId: SITE });
    expect(current?.id).toBe(shared.id);
    expect(prunedIds).not.toContain(shared.id);
    // hash-pub is still referenced by the current deployment: never deletable.
    expect(unreferencedRefs).not.toContain("bundles/hash-pub.json");

    const history = await listDeployments(db, { siteId: SITE, limit: 50 });
    const pruned = history.filter((d) => d.status === "pruned");
    expect(pruned.map((d) => d.id)).toEqual(expect.arrayContaining(prunedIds));
  });
});
