import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Db,
  type Storage,
  createDb,
  createFsStorage,
  runMigrations,
  searchEndpoints,
  upsertSite,
} from "@readsmith/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type IngestDeps, ingestSpec } from "../src/ingest.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;

const petstore = (extra?: string) =>
  JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Pets", version: "1.0.0" },
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          summary: "List pets",
          tags: ["Pets"],
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
            },
          },
        },
      },
      ...(extra
        ? {}
        : {
            "/pets/{id}": {
              get: { operationId: "getPet", responses: { "200": { description: "ok" } } },
            },
          }),
    },
    components: { schemas: { Pet: { type: "object", properties: { id: { type: "integer" } } } } },
  });

describe.skipIf(!DATABASE_URL)("ingestSpec (integration)", () => {
  let db: Db;
  let storage: Storage;
  let root: string;
  let deps: IngestDeps;
  const files = new Map<string, string>();

  beforeAll(async () => {
    db = createDb({
      databaseUrl: DATABASE_URL ?? "",
      storageRoot: ".rs-test",
      workerConcurrency: 1,
      logLevel: "error",
    });
    await runMigrations(db);
    await upsertSite(db, { id: "default", name: "Readsmith" });
    root = await mkdtemp(join(tmpdir(), "rs-ingest-"));
    storage = createFsStorage(join(root, "store"));
    deps = {
      db,
      storage,
      readSource: async (p) => {
        const raw = files.get(p);
        if (raw === undefined) throw new Error(`no source ${p}`);
        return { raw };
      },
    };
  });

  afterAll(async () => {
    await db?.close();
    await rm(root, { recursive: true, force: true });
  });

  it("normalizes, persists, and indexes an OpenAPI spec", async () => {
    files.set("pets.json", petstore());
    const result = await ingestSpec(deps, { siteId: "default", sourcePath: "pets.json" });
    expect(result.skipped).toBe(false);
    expect(result.version).toBe(1);
    expect(result.endpoints).toBe(2);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const hits = await searchEndpoints(db, { siteId: "default", query: "list pets" });
    expect(hits.map((h) => h.operation_id)).toContain("listPets");
  });

  it("is idempotent on identical bytes", async () => {
    const again = await ingestSpec(deps, { siteId: "default", sourcePath: "pets.json" });
    expect(again.skipped).toBe(true);
    expect(again.version).toBe(1);
  });

  it("versions a changed spec and diffs breaking changes against the prior version", async () => {
    // Second version removes /pets/{id}.
    files.set("pets.json", petstore("changed"));
    const v2 = await ingestSpec(deps, { siteId: "default", sourcePath: "pets.json" });
    expect(v2.skipped).toBe(false);
    expect(v2.version).toBe(2);
    expect(v2.changes.some((c) => c.kind === "endpoint-removed")).toBe(true);
  });

  it("bundles external multi-file $refs (AC-3)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rs-multi-"));
    const main = join(dir, "main.json");
    const ext = join(dir, "pet.json");
    await writeFile(
      ext,
      JSON.stringify({ Pet: { type: "object", properties: { id: { type: "integer" } } } }),
    );
    const mainDoc = {
      openapi: "3.0.0",
      info: { title: "Multi", version: "1.0.0" },
      paths: {
        "/pets": {
          get: {
            operationId: "listPets",
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": { schema: { $ref: "./pet.json#/Pet" } } },
              },
            },
          },
        },
      },
    };
    const rawMain = JSON.stringify(mainDoc);
    await writeFile(main, rawMain);

    const multiDeps: IngestDeps = {
      db,
      storage,
      readSource: async () => ({ raw: rawMain, fsPath: main }),
    };
    const result = await ingestSpec(multiDeps, { siteId: "default", sourcePath: "multi.json" });
    expect(result.diagnostics.some((d) => d.code === "bundle-failed")).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "unresolved-ref")).toBe(false);
    expect(result.endpoints).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });
});
