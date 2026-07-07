import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDatabase, loadDbConfig } from "../src/config.js";
import { resolveMigrations } from "../src/migrate.js";
import { maskUrlCredentials, redactConnectionString, redactForLog } from "../src/redact.js";
import { vectorLiteral } from "../src/repos.js";
import { aiQueryRowSchema, docChunkRowSchema } from "../src/schema.js";
import { joinSql, sql } from "../src/sql.js";
import { createFsStorage } from "../src/storage.js";

// Config spec CF-3, AC-10.
describe("config", () => {
  it("fails fast with a clear, secret-free message when DATABASE_URL is missing", () => {
    expect(() => loadDbConfig({})).toThrow(/DATABASE_URL is required/);
    // The thrown message must not contain any value that could be a secret.
    try {
      loadDbConfig({});
    } catch (e) {
      expect((e as Error).message).not.toContain("postgres://");
    }
  });

  it("applies sane defaults and detects presence", () => {
    const c = loadDbConfig({ DATABASE_URL: "postgres://u:p@h/db" });
    expect(c.storageRoot).toBe(".readsmith/storage");
    expect(c.workerConcurrency).toBe(2);
    expect(c.logLevel).toBe("info");
    expect(hasDatabase({ DATABASE_URL: "x" })).toBe(true);
    expect(hasDatabase({})).toBe(false);
  });
});

// Persistence spec DA-4, NFR-3, AC-6.
describe("redaction", () => {
  it("masks credentials in a connection URL", () => {
    expect(maskUrlCredentials("postgres://user:s3cret@db:5432/app")).toBe(
      "postgres://user:***@db:5432/app",
    );
  });

  it("masks password in key/value connection strings", () => {
    expect(redactConnectionString("host=db password=s3cret sslmode=require")).toBe(
      "host=db password=*** sslmode=require",
    );
  });

  it("redacts secret keys and nested credential URLs together for logging", () => {
    const out = redactForLog({
      token: "abc",
      note: "connect to postgres://u:p@h/db please",
      nested: { authorization: "Bearer x" },
    }) as Record<string, unknown>;
    expect(out.token).toBe("[REDACTED]");
    expect(out.note).toBe("connect to postgres://u:***@h/db please");
    expect((out.nested as Record<string, unknown>).authorization).toBe("[REDACTED]");
  });
});

// Persistence spec DA-2, AC-5: only parameterized SQL is expressible.
describe("sql tag", () => {
  it("binds interpolated values as ordered $n parameters, never as text", () => {
    const q = sql`SELECT * FROM t WHERE a = ${1} AND b = ${"x"}`;
    expect(q.text).toBe("SELECT * FROM t WHERE a = $1 AND b = $2");
    expect(q.values).toEqual([1, "x"]);
    // A value that looks like SQL stays a bound parameter, not injected text.
    const evil = sql`WHERE name = ${"'; DROP TABLE users; --"}`;
    expect(evil.text).toBe("WHERE name = $1");
    expect(evil.values).toEqual(["'; DROP TABLE users; --"]);
  });

  it("composes nested fragments with renumbered placeholders", () => {
    const cond = sql`b = ${2}`;
    const q = sql`SELECT * FROM t WHERE a = ${1} AND ${cond} AND c = ${3}`;
    expect(q.text).toBe("SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $3");
    expect(q.values).toEqual([1, 2, 3]);
  });

  it("joins fragments for bulk statements", () => {
    const rows = [sql`(${1}, ${"a"})`, sql`(${2}, ${"b"})`];
    const q = sql`INSERT INTO t (n, s) VALUES ${joinSql(rows, ", ")}`;
    expect(q.text).toBe("INSERT INTO t (n, s) VALUES ($1, $2), ($3, $4)");
    expect(q.values).toEqual([1, "a", 2, "b"]);
  });
});

// Persistence spec MG-1: filename convention + ordering.
describe("migration resolver", () => {
  it("orders by numeric prefix and ignores non-sql files", () => {
    const plan = resolveMigrations(["0002_b.sql", "README.md", "0001_a.sql"]);
    expect(plan.map((m) => m.name)).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  it("rejects a malformed .sql name and duplicate order numbers", () => {
    expect(() => resolveMigrations(["1_bad.sql"])).toThrow(/does not match/);
    expect(() => resolveMigrations(["0001_a.sql", "0001_b.sql"])).toThrow(
      /Duplicate migration order/,
    );
  });
});

// Persistence spec ST-1: content-addressed storage.
describe("fs storage", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "rs-store-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips bytes and content-addresses (same bytes -> same ref)", async () => {
    const store = createFsStorage(root);
    const ref1 = await store.put("hello world");
    const ref2 = await store.put("hello world");
    const ref3 = await store.put("different");
    expect(ref1).toBe(ref2);
    expect(ref1).not.toBe(ref3);
    expect(ref1.startsWith("sha256:")).toBe(true);
    expect((await store.get(ref1)).toString()).toBe("hello world");
    expect(await store.has(ref1)).toBe(true);
    expect(await store.has("sha256:deadbeef")).toBe(false);
  });
});

// M3 (0002): doc-chunk index + Ask-AI query-log row shapes and vector formatting.
describe("ai index rows", () => {
  it("formats an embedding as a pgvector literal or passes null through", () => {
    expect(vectorLiteral([0.1, 0.2, -0.3])).toBe("[0.1,0.2,-0.3]");
    expect(vectorLiteral(null)).toBeNull();
  });

  it("parses a doc_chunk row and an ai_query row at the boundary", () => {
    const chunk = docChunkRowSchema.parse({
      id: "c1",
      site_id: "default",
      kind: "doc",
      endpoint_id: null,
      page_id: "p1",
      path: "/guide",
      header_path: ["Guide", "Setup"],
      anchor: "setup",
      method: null,
      version_id: "current",
      locale: "en",
      content_hash: "h1",
      text: "hello",
      created_at: new Date(),
    });
    expect(chunk.header_path).toEqual(["Guide", "Setup"]);

    const q = aiQueryRowSchema.parse({
      id: "q1",
      site_id: "default",
      query: "how do i",
      filters: { version: "current" },
      retrieved_chunk_ids: ["c1"],
      answer: "do x",
      cited_ids: ["c1"],
      model: { chat: "openai:gpt" },
      input_tokens: 1200,
      output_tokens: 240,
      cost_estimate: 0.0031,
      latency_ms: 42,
      feedback: null,
      created_at: new Date(),
    });
    expect(q.cited_ids).toEqual(["c1"]);
    expect(q.model).toEqual({ chat: "openai:gpt" });
    expect(q.input_tokens).toBe(1200);
    expect(q.cost_estimate).toBeCloseTo(0.0031);
  });
});
