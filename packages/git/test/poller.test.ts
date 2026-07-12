import {
  type Db,
  createDb,
  insertDeployment,
  runMigrations,
  setLastSyncedSha,
  sql,
  upsertGitConnection,
  upsertSite,
} from "@readsmith/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GitHubProvider } from "../src/github.js";
import { createPoller } from "../src/poller.js";
import type { SiteBuildPayload } from "../src/site-build.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!DATABASE_URL)("poller (integration)", () => {
  const SITE = "poll-test";
  let db: Db;
  let head = "poll-sha-1";
  let enqueued: SiteBuildPayload[];

  const provider: GitHubProvider = {
    resolveToken: async () => "tok",
    resolveBranch: async (_ref, branch) => ({ branch: branch ?? "main", headSha: head }),
    fetchAtRef: async () => {},
  };

  const poller = () =>
    createPoller({ db, provider, siteId: SITE, enqueue: async (p) => void enqueued.push(p) });

  beforeAll(async () => {
    db = createDb({
      databaseUrl: DATABASE_URL ?? "",
      storageRoot: ".rs-test",
      workerConcurrency: 2,
      logLevel: "error",
    });
    await runMigrations(db);
    await upsertSite(db, { id: SITE, name: "Poll Test" });
    await db.query(sql`DELETE FROM app.deployments WHERE site_id = ${SITE}`);
    await db.query(sql`DELETE FROM app.git_connections WHERE site_id = ${SITE}`);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("reports no-connection before any bind", async () => {
    enqueued = [];
    expect(await poller().checkOnce()).toBe("no-connection");
    expect(enqueued).toEqual([]);
  });

  it("enqueues when the head moves past the last built commit", async () => {
    await upsertGitConnection(db, {
      id: `conn:${SITE}:acme/docs`,
      siteId: SITE,
      provider: "github",
      installationId: null,
      repo: "acme/docs",
      branch: "main",
    });
    enqueued = [];
    expect(await poller().checkOnce()).toBe("queued");
    expect(enqueued).toEqual([
      { siteId: SITE, repo: "acme/docs", ref: "refs/heads/main", commitSha: "poll-sha-1" },
    ]);
  });

  it("stays quiet while a deployment for that head already exists (no failed-build hot loop)", async () => {
    // The enqueued build opened a row (simulate) but has not published yet.
    await insertDeployment(db, { siteId: SITE, gitRef: "refs/heads/main", commitSha: head });
    enqueued = [];
    expect(await poller().checkOnce()).toBe("unchanged");
    expect(enqueued).toEqual([]);
  });

  it("stays quiet once last_synced_sha records the built head, and wakes on a new one", async () => {
    const conn = `conn:${SITE}:acme/docs`;
    await setLastSyncedSha(db, { id: conn, sha: head });
    enqueued = [];
    expect(await poller().checkOnce()).toBe("unchanged");

    head = "poll-sha-2";
    expect(await poller().checkOnce()).toBe("queued");
    expect(enqueued.map((p) => p.commitSha)).toEqual(["poll-sha-2"]);
  });

  it("swallows provider faults as an error outcome, never a throw", async () => {
    const broken = createPoller({
      db,
      provider: {
        ...provider,
        resolveBranch: async () => {
          throw new Error("api down");
        },
      },
      siteId: SITE,
      enqueue: async () => {},
    });
    expect(await broken.checkOnce()).toBe("error");
  });
});
