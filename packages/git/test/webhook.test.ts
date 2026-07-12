import { createHmac } from "node:crypto";
import {
  type Db,
  createDb,
  getGitConnection,
  runMigrations,
  sql,
  upsertGitConnection,
  upsertSite,
} from "@readsmith/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SiteBuildPayload } from "../src/site-build.js";
import { createWebhookHandler, parseWebhookEvent, verifyWebhookSignature } from "../src/webhook.js";

const SECRET = "hook-secret";

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function delivery(event: string, payload: unknown, opts: { signature?: string | null } = {}) {
  const body = JSON.stringify(payload);
  const headers = new Headers({ "x-github-event": event, "content-type": "application/json" });
  const signature = opts.signature === undefined ? sign(body) : opts.signature;
  if (signature !== null) headers.set("x-hub-signature-256", signature);
  return new Request("http://localhost/_readsmith/api/git/webhook", {
    method: "POST",
    headers,
    body,
  });
}

const pushPayload = (repo: string, branch: string, after = "abc123def456") => ({
  ref: `refs/heads/${branch}`,
  after,
  deleted: false,
  repository: { full_name: repo },
});

describe("verifyWebhookSignature", () => {
  it("accepts the right signature and rejects everything else", () => {
    const body = '{"a":1}';
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
    expect(verifyWebhookSignature(body, sign(body, "wrong"), SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "sha256=deadbeef", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "sha1=abc", SECRET)).toBe(false);
    expect(verifyWebhookSignature(`${body} `, sign(body), SECRET)).toBe(false);
  });
});

describe("parseWebhookEvent", () => {
  it("classifies pushes, branch deletions, and non-branch refs", () => {
    expect(parseWebhookEvent("push", pushPayload("acme/hook-docs", "main"))).toEqual({
      kind: "push",
      repo: "acme/hook-docs",
      branch: "main",
      headSha: "abc123def456",
      deleted: false,
    });
    const gone = parseWebhookEvent("push", {
      ...pushPayload("acme/hook-docs", "main", "0000000000000000000000000000000000000000"),
      deleted: true,
    });
    expect(gone.kind === "push" && gone.deleted).toBe(true);
    expect(parseWebhookEvent("push", { ref: "refs/tags/v1", repository: {} }).kind).toBe("ignored");
  });

  it("classifies installation lifecycles", () => {
    const created = parseWebhookEvent("installation", {
      action: "created",
      installation: { id: 42 },
      repositories: [{ full_name: "acme/hook-docs" }],
    });
    expect(created).toEqual({
      kind: "installation",
      installationId: "42",
      reposBound: ["acme/hook-docs"],
      reposUnbound: [],
    });
    const removed = parseWebhookEvent("installation_repositories", {
      action: "removed",
      installation: { id: 42 },
      repositories_removed: [{ full_name: "acme/hook-docs" }],
    });
    expect(removed.kind === "installation" && removed.reposUnbound).toEqual(["acme/hook-docs"]);
    expect(parseWebhookEvent("issues", {}).kind).toBe("ignored");
  });
});

const DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!DATABASE_URL)("webhook handler (integration)", () => {
  const SITE = "hook-test";
  let db: Db;
  let enqueued: SiteBuildPayload[];

  const handler = () =>
    createWebhookHandler({
      db,
      secret: SECRET,
      enqueue: async (p) => {
        enqueued.push(p);
      },
    });

  beforeAll(async () => {
    db = createDb({
      databaseUrl: DATABASE_URL ?? "",
      storageRoot: ".rs-test",
      workerConcurrency: 2,
      logLevel: "error",
    });
    await runMigrations(db);
    await upsertSite(db, { id: SITE, name: "Hook Test" });
    await db.query(sql`DELETE FROM app.git_connections WHERE site_id = ${SITE}`);
    await upsertGitConnection(db, {
      id: `conn:${SITE}:acme/hook-docs`,
      siteId: SITE,
      provider: "github",
      installationId: null,
      repo: "acme/hook-docs",
      branch: "main",
    });
  });

  afterAll(async () => {
    await db?.close();
  });

  it("rejects a bad signature with 401 and no side effect", async () => {
    enqueued = [];
    const res = await handler()(
      delivery("push", pushPayload("acme/hook-docs", "main"), { signature: "sha256=bad" }),
    );
    expect(res.status).toBe(401);
    expect(enqueued).toEqual([]);
  });

  it("fails loudly when no secret is configured, echoing nothing", async () => {
    const res = await createWebhookHandler({
      db,
      secret: null,
      enqueue: async () => {},
    })(delivery("push", pushPayload("acme/hook-docs", "main")));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("acks ping and unknown events", async () => {
    expect((await handler()(delivery("ping", { zen: "ok" }))).status).toBe(200);
    expect((await handler()(delivery("workflow_run", {}))).status).toBe(200);
  });

  it("enqueues one superseding build for a push to the connected repo+branch", async () => {
    enqueued = [];
    const res = await handler()(
      delivery("push", pushPayload("ACME/hook-docs", "main", "sha-push-1")),
    );
    expect(res.status).toBe(202);
    expect(enqueued).toEqual([
      { siteId: SITE, repo: "acme/hook-docs", ref: "refs/heads/main", commitSha: "sha-push-1" },
    ]);
  });

  it("ignores pushes to other branches, other repos, and deletions", async () => {
    enqueued = [];
    expect(
      (await handler()(delivery("push", pushPayload("acme/hook-docs", "feature")))).status,
    ).toBe(202);
    expect((await handler()(delivery("push", pushPayload("other/repo", "main")))).status).toBe(202);
    const gone = {
      ...pushPayload("acme/hook-docs", "main", "0000000000000000000000000000000000000000"),
      deleted: true,
    };
    expect((await handler()(delivery("push", gone))).status).toBe(200);
    expect(enqueued).toEqual([]);
  });

  it("records and clears the installation id from installation events", async () => {
    const bind = {
      action: "created",
      installation: { id: 4242 },
      repositories: [{ full_name: "acme/hook-docs" }],
    };
    expect((await handler()(delivery("installation", bind))).status).toBe(200);
    expect((await getGitConnection(db, SITE))?.installation_id).toBe("4242");

    const unbind = {
      action: "deleted",
      installation: { id: 4242 },
      repositories: [{ full_name: "acme/hook-docs" }],
    };
    expect((await handler()(delivery("installation", unbind))).status).toBe(200);
    expect((await getGitConnection(db, SITE))?.installation_id).toBeNull();
  });
});
