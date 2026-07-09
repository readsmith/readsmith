import { createMemoryCache } from "@readsmith/cache";
import type { SearchFilters } from "@readsmith/model";
import { describe, expect, it, vi } from "vitest";
import {
  type ModelProvider,
  type RetrievalStore,
  type RetrievedChunk,
  createMockProvider,
  fakeEmbedding,
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
  // AC-1.4
  it("AC-1.4: fuses both arms, maps deep links, and reports degraded=false", async () => {
    const store = fakeStore([chunk("a"), chunk("b")], [chunk("b"), chunk("c")]);
    const { hits, degraded } = await hybridSearch(
      { store, provider: createMockProvider(), baseUrl: "https://d.example" },
      { siteId: "default", query: "hello", filters },
    );
    expect(hits[0]?.id).toBe("b"); // in both arms
    expect(hits[0]?.url).toBe("https://d.example/b#b");
    expect(hits[0]?.title).toBe("b");
    expect(hits.every((h) => h.score > 0)).toBe(true);
    expect(hits.map((h) => h.id).sort()).toEqual(["a", "b", "c"]); // both arms contributed
    expect(degraded).toBe(false);
  });

  it("maps endpoint hits with method/path and the api-reference link", async () => {
    const ep = chunk("op-list-users", {
      kind: "endpoint",
      path: "/users",
      anchor: "op-list-users",
      method: "GET",
    });
    const store = fakeStore([], [ep]);
    const { hits } = await hybridSearch(
      {
        store,
        provider: createMockProvider({ hasEmbedding: false }),
        apiBasePath: "/api-reference",
      },
      { siteId: "default", query: "users", filters },
    );
    const [hit] = hits;
    expect(hit?.kind).toBe("endpoint");
    expect(hit?.method).toBe("GET");
    expect(hit?.path).toBe("/users");
    expect(hit?.url).toBe("/api-reference#op-list-users");
  });

  // AC-1.3: no key is a configured mode, not a failure. It must not read as degraded.
  it("AC-1.3: degenerates to the FTS arm when there is no embedding key, degraded=false", async () => {
    const store = fakeStore([chunk("should-not-appear")], [chunk("fts-only")]);
    const { hits, degraded } = await hybridSearch(
      { store, provider: createMockProvider({ hasEmbedding: false }) },
      { siteId: "default", query: "x", filters },
    );
    // vector arm skipped entirely, so its rows never surface.
    expect(hits.map((h) => h.id)).toEqual(["fts-only"]);
    expect(degraded).toBe(false);
  });

  it("caches the query embedding so a repeat skips the provider (RT-5)", async () => {
    const store = fakeStore([chunk("a")], [chunk("a")]);
    const cache = createMemoryCache();
    let embedCalls = 0;
    const provider = createMockProvider({
      embed: (t) => {
        embedCalls++;
        return fakeEmbedding(t);
      },
    });
    const deps = { store, provider, cache };
    const input = { siteId: "default", query: "how to auth", filters };

    await hybridSearch(deps, input);
    await hybridSearch(deps, input); // same query -> served from cache
    expect(embedCalls).toBe(1);
  });
});

/**
 * Item 1 (RT-DEGRADE). A configured embedding provider that fails at request time
 * must cost us the vector arm, not the whole search. This is the exact shape of a
 * tripped spend cap: the gateway starts erroring, and search has to keep working.
 */
describe("hybridSearch: runtime degradation", () => {
  /** A provider that claims an embedding key and then fails, like a 429 or a 402. */
  const failingProvider = (message = "provider unavailable"): ModelProvider => ({
    hasChat: () => false,
    hasEmbedding: () => true,
    chat: () => {
      throw new Error("no chat");
    },
    embedMany: async () => {
      throw new Error(message);
    },
  });

  // AC-1.1, AC-1.2
  it("AC-1.1/1.2: resolves with the FTS hits and degraded=true when embedding rejects", async () => {
    const store = fakeStore([chunk("vector-only")], [chunk("fts-a"), chunk("fts-b")]);
    const { hits, degraded } = await hybridSearch(
      { store, provider: failingProvider("429 rate limited") },
      { siteId: "default", query: "x", filters },
    );
    expect(hits.map((h) => h.id)).toEqual(["fts-a", "fts-b"]);
    expect(degraded).toBe(true);
  });

  it("never calls the vector store when the embedding failed", async () => {
    const vectorSearch = vi.fn(async () => [chunk("nope")]);
    const store: RetrievalStore = { vectorSearch, ftsSearch: async () => [chunk("fts")] };
    const { degraded } = await hybridSearch(
      { store, provider: failingProvider() },
      { siteId: "default", query: "x", filters },
    );
    expect(vectorSearch).not.toHaveBeenCalled();
    expect(degraded).toBe(true);
  });

  it("warns once, naming the provider error, so an operator sees a dead key", async () => {
    const warn = vi.fn();
    await hybridSearch(
      {
        store: fakeStore([], [chunk("fts")]),
        provider: failingProvider("402 spend cap exceeded"),
        logger: { warn },
      },
      { siteId: "default", query: "x", filters },
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ err: "402 spend cap exceeded" });
  });

  it("degrades silently when no logger is supplied", async () => {
    const { degraded } = await hybridSearch(
      { store: fakeStore([], [chunk("fts")]), provider: failingProvider() },
      { siteId: "default", query: "x", filters },
    );
    expect(degraded).toBe(true);
  });

  // AC-1.6: the database is the one dependency whose loss is fatal. Both arms read
  // it, so there is nothing left to serve.
  it("AC-1.6: still rejects when the store fails", async () => {
    const store: RetrievalStore = {
      async vectorSearch() {
        return [];
      },
      async ftsSearch() {
        throw new Error("postgres unreachable");
      },
    };
    await expect(
      hybridSearch(
        { store, provider: createMockProvider({ hasEmbedding: false }) },
        { siteId: "default", query: "x", filters },
      ),
    ).rejects.toThrow("postgres unreachable");
  });

  it("AC-1.6: a failing vector store is fatal, not degradation", async () => {
    const store: RetrievalStore = {
      async vectorSearch() {
        throw new Error("postgres unreachable");
      },
      async ftsSearch() {
        return [chunk("fts")];
      },
    };
    await expect(
      hybridSearch(
        { store, provider: createMockProvider() },
        { siteId: "default", query: "x", filters },
      ),
    ).rejects.toThrow("postgres unreachable");
  });

  it("a broken cache is a miss, not an outage", async () => {
    const brokenCache = {
      get: async () => {
        throw new Error("redis down");
      },
      set: async () => {
        throw new Error("redis down");
      },
      delete: async () => {},
      clear: async () => {},
    };
    const { hits, degraded } = await hybridSearch(
      {
        store: fakeStore([chunk("vec")], [chunk("fts")]),
        provider: createMockProvider(),
        cache: brokenCache,
      },
      { siteId: "default", query: "x", filters },
    );
    expect(hits.map((h) => h.id).sort()).toEqual(["fts", "vec"]); // both arms ran
    expect(degraded).toBe(false);
  });
});
