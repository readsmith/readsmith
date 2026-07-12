import {
  type Db,
  createDb,
  insertDeployment,
  runMigrations,
  sql,
  upsertGitConnection,
  upsertSite,
} from "@readsmith/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureGitConnection } from "../src/bind.js";
import type { GitHubProvider } from "../src/github.js";
import type { SiteBuildPayload } from "../src/site-build.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;

const provider: GitHubProvider = {
  resolveToken: async () => "tok",
  resolveBranch: async (_ref, branch) => ({ branch: branch ?? "main", headSha: "bind-head-1" }),
  fetchAtRef: async () => {
    throw new Error("not used here");
  },
};

describe.skipIf(!DATABASE_URL)("ensureGitConnection (integration)", () => {
  let db: Db;
  let enqueued: SiteBuildPayload[];

  beforeAll(async () => {
    db = createDb({
      databaseUrl: DATABASE_URL ?? "",
      storageRoot: ".rs-test",
      workerConcurrency: 2,
      logLevel: "error",
    });
    await runMigrations(db);
    for (const site of ["bind-fresh", "bind-existing"]) {
      await upsertSite(db, { id: site, name: site });
      await db.query(sql`DELETE FROM app.deployments WHERE site_id = ${site}`);
      await db.query(sql`DELETE FROM app.git_connections WHERE site_id = ${site}`);
    }
  });

  afterAll(async () => {
    await db?.close();
  });

  it("binds a fresh site and auto-enqueues the initial build at the branch head", async () => {
    enqueued = [];
    const row = await ensureGitConnection(
      { db, provider, enqueue: async (p) => void enqueued.push(p) },
      { siteId: "bind-fresh", repo: "acme/docs", branch: null },
    );
    expect(row.repo).toBe("acme/docs");
    expect(row.branch).toBe("main"); // resolved default
    expect(enqueued).toEqual([
      {
        siteId: "bind-fresh",
        repo: "acme/docs",
        ref: "refs/heads/main",
        commitSha: "bind-head-1",
      },
    ]);
  });

  it("does not auto-build a site that already has deployment history", async () => {
    await insertDeployment(db, {
      siteId: "bind-existing",
      gitRef: "refs/heads/main",
      commitSha: "prior-sha",
    });
    enqueued = [];
    await ensureGitConnection(
      { db, provider, enqueue: async (p) => void enqueued.push(p) },
      { siteId: "bind-existing", repo: "acme/docs", branch: "docs" },
    );
    expect(enqueued).toEqual([]);
  });

  it("keeps a webhook-recorded installation id when re-binding the same repo", async () => {
    await upsertGitConnection(db, {
      id: "conn:bind-existing:acme/docs",
      siteId: "bind-existing",
      provider: "github",
      installationId: "777",
      repo: "acme/docs",
      branch: "docs",
    });
    const row = await ensureGitConnection(
      { db, provider, enqueue: async () => {} },
      { siteId: "bind-existing", repo: "acme/docs", branch: null },
    );
    expect(row.installation_id).toBe("777");
    expect(row.branch).toBe("docs"); // existing branch kept when config sets none
  });
});
