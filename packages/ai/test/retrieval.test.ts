import type { SearchFilters } from "@readsmith/model";
import { describe, expect, it } from "vitest";
import {
  type RetrievalStore,
  type RetrievedChunk,
  createMockProvider,
  hybridSearch,
  rrfFuse,
} from "../src/index.js";

const chunk = (id: string, over: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
  id,
  kind: "doc",
  pageId: `p-${id}`,
  path: `/${id}`,
  headerPath: ["Guide", id],
  anchor: id,
  method: null,
  text: `text for ${id}`,
  ...over,
});

const filters: SearchFilters = { version: "current", locale: "en" };

/** A store returning fixed ranked lists, so fusion is tested without a DB. */
function fakeStore(vector: RetrievedChunk[], fts: RetrievedChunk[]): RetrievalStore {
  return {
    async vectorSearch() {
      return vector;
    },
    async ftsSearch() {
      return fts;
    },
  };
}

describe("rrfFuse", () => {
  it("rewards items ranked highly in both lists", () => {
    const a = chunk("a");
    const b = chunk("b");
    const c = chunk("c");
    // a: #1 vector + #2 fts; b: #2 vector; c: #1 fts.
    const fused = rrfFuse(
      [
        [a, b],
        [c, a],
      ],
      60,
    );
    expect(fused[0]?.chunk.id).toBe("a"); // appears near top of both
    expect(fused.map((f) => f.chunk.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("is a no-op fold over empty lists", () => {
    expect(rrfFuse([[], []], 60)).toEqual([]);
  });
});

describe("hybridSearch", () => {
  it("fuses both arms and maps to Hits with deep links", async () => {
    const store = fakeStore([chunk("a"), chunk("b")], [chunk("b"), chunk("c")]);
    const hits = await hybridSearch(
      { store, provider: createMockProvider(), baseUrl: "https://d.example" },
      { siteId: "default", query: "hello", filters },
    );
    expect(hits[0]?.id).toBe("b"); // in both arms
    expect(hits[0]?.url).toBe("https://d.example/b#b");
    expect(hits[0]?.title).toBe("b");
    expect(hits.every((h) => h.score > 0)).toBe(true);
  });

  it("maps endpoint hits with method/path and the api-reference link", async () => {
    const ep = chunk("op-list-users", {
      kind: "endpoint",
      path: "/users",
      anchor: "op-list-users",
      method: "GET",
    });
    const store = fakeStore([], [ep]);
    const [hit] = await hybridSearch(
      {
        store,
        provider: createMockProvider({ hasEmbedding: false }),
        apiBasePath: "/api-reference",
      },
      { siteId: "default", query: "users", filters },
    );
    expect(hit?.kind).toBe("endpoint");
    expect(hit?.method).toBe("GET");
    expect(hit?.path).toBe("/users");
    expect(hit?.url).toBe("/api-reference#op-list-users");
  });

  it("degenerates to the FTS arm when there is no embedding key", async () => {
    const store = fakeStore([chunk("should-not-appear")], [chunk("fts-only")]);
    const hits = await hybridSearch(
      { store, provider: createMockProvider({ hasEmbedding: false }) },
      { siteId: "default", query: "x", filters },
    );
    // vector arm skipped entirely, so its rows never surface.
    expect(hits.map((h) => h.id)).toEqual(["fts-only"]);
  });
});
