import { describe, expect, it } from "vitest";
import {
  type IndexChunk,
  type IndexStore,
  type SourceChunk,
  createMockProvider,
  indexChunks,
} from "../src/index.js";

/** An in-memory IndexStore so the pipeline is tested without a database. */
function memStore(): IndexStore & { rows: Map<string, IndexChunk> } {
  const rows = new Map<string, IndexChunk>();
  return {
    rows,
    async listChunkHashes() {
      return [...rows.values()].map((r) => ({ id: r.id, contentHash: r.contentHash }));
    },
    async upsertChunks({ chunks }) {
      for (const c of chunks) rows.set(c.id, c);
      return chunks.length;
    },
    async deleteChunksNotIn({ keepIds }) {
      const keep = new Set(keepIds);
      let n = 0;
      for (const id of [...rows.keys()]) {
        if (!keep.has(id)) {
          rows.delete(id);
          n++;
        }
      }
      return n;
    },
  };
}

const chunk = (id: string, text: string): SourceChunk => ({
  id,
  kind: "doc",
  endpointId: null,
  pageId: `p-${id}`,
  path: `/${id}`,
  headerPath: ["Guide"],
  anchor: id,
  method: null,
  text,
});

const input = (chunks: SourceChunk[]) => ({
  siteId: "default",
  version: "current",
  locale: "en",
  chunks,
});

describe("embed.index (indexChunks)", () => {
  it("first index embeds every chunk and writes vectors", async () => {
    const store = memStore();
    const deps = { store, provider: createMockProvider() };
    const r = await indexChunks(deps, input([chunk("a", "alpha"), chunk("b", "beta")]));

    expect(r).toMatchObject({
      total: 2,
      changed: 2,
      skipped: 0,
      embedded: 2,
      deleted: 0,
      vectors: true,
    });
    expect(store.rows.get("a")?.embedding).toHaveLength(1024);
    expect(store.rows.get("a")?.versionId).toBe("current");
  });

  it("re-indexing an unchanged bundle is a no-op (idempotent)", async () => {
    const store = memStore();
    const deps = { store, provider: createMockProvider() };
    const chunks = [chunk("a", "alpha"), chunk("b", "beta")];
    await indexChunks(deps, input(chunks));
    const r = await indexChunks(deps, input(chunks));
    expect(r).toMatchObject({ changed: 0, skipped: 2, embedded: 0, deleted: 0 });
  });

  it("re-embeds only the chunk whose text changed", async () => {
    const store = memStore();
    const deps = { store, provider: createMockProvider() };
    await indexChunks(deps, input([chunk("a", "alpha"), chunk("b", "beta")]));
    const before = store.rows.get("b")?.embedding;

    const r = await indexChunks(deps, input([chunk("a", "ALPHA v2"), chunk("b", "beta")]));
    expect(r).toMatchObject({ changed: 1, skipped: 1, embedded: 1, deleted: 0 });
    // b was untouched; a was re-embedded to a new vector.
    expect(store.rows.get("b")?.embedding).toEqual(before);
    expect(store.rows.get("a")?.contentHash).toBeTruthy();
  });

  it("prunes chunks removed from the source", async () => {
    const store = memStore();
    const deps = { store, provider: createMockProvider() };
    await indexChunks(deps, input([chunk("a", "alpha"), chunk("b", "beta")]));
    const r = await indexChunks(deps, input([chunk("a", "alpha")]));
    expect(r.deleted).toBe(1);
    expect(store.rows.has("b")).toBe(false);
  });

  it("writes FTS-only rows (null embedding) when no embedding provider is configured", async () => {
    const store = memStore();
    const deps = { store, provider: createMockProvider({ hasEmbedding: false }) };
    const r = await indexChunks(deps, input([chunk("a", "alpha")]));
    expect(r).toMatchObject({ changed: 1, embedded: 0, vectors: false });
    expect(store.rows.get("a")?.embedding).toBeNull();
  });
});
