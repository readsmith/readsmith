import type { Cache } from "@readsmith/cache";
import type { SearchFilters, SearchHit, SearchResult } from "@readsmith/model";
import type { ModelProvider } from "./provider.js";

/**
 * Hybrid retrieval: run the vector and FTS arms concurrently, fuse by Reciprocal
 * Rank Fusion, map to `SearchHit`. Every arm is hard-filtered by version/locale
 * (the parity feature). With no embedding key the vector arm is empty and RRF
 * degenerates to FTS through the same code path. No LLM is involved, so this
 * powers the instant command palette.
 *
 * There are three states, not two. "No embedding key" is a configured mode, not a
 * failure. "Embedding key present and the provider is failing" is degradation: the
 * FTS arm still has answers, so we return them and say so, rather than failing the
 * whole search. Losing the database is fatal; losing a provider is not.
 */

/** A chunk row from either retrieval arm (the DB store returns these, best-first). */
export interface RetrievedChunk {
  id: string;
  kind: "doc" | "endpoint";
  pageId: string | null;
  path: string;
  headerPath: string[];
  anchor: string | null;
  method: string | null;
  text: string;
}

/** The retrieval persistence port (backed by `@readsmith/db` repos in the host). */
export interface RetrievalStore {
  vectorSearch(input: {
    siteId: string;
    filters: SearchFilters;
    embedding: number[];
    limit: number;
  }): Promise<RetrievedChunk[]>;
  ftsSearch(input: {
    siteId: string;
    filters: SearchFilters;
    query: string;
    limit: number;
  }): Promise<RetrievedChunk[]>;
}

/** A place to report degradation. The host passes its logger; tests pass a spy. */
export interface SearchLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface SearchDeps {
  store: RetrievalStore;
  provider: ModelProvider;
  /** Prefix for built links (default relative: ""). */
  baseUrl?: string;
  /** Where the API reference is served (default "/api-reference"). */
  apiBasePath?: string;
  /** RRF constant k (default 60, the standard). */
  rrfK?: number;
  /** Optional cache for the query embedding (RT-5), so repeats skip the provider. */
  cache?: Cache;
  /** TTL for a cached query embedding (falls back to the cache default). */
  queryEmbedTtlMs?: number;
  /** Warn sink for a failing embedding provider. Optional; absent means silent. */
  logger?: SearchLogger;
}

/** A cache miss and a broken cache are the same thing to a caller: recompute. */
async function cachedEmbedding(deps: SearchDeps, key: string): Promise<number[] | undefined> {
  if (!deps.cache) return undefined;
  try {
    return await deps.cache.get<number[]>(key);
  } catch {
    return undefined;
  }
}

/**
 * Embed a query, served from cache on a repeat within the TTL. Returns null when
 * the provider cannot answer, rather than rejecting: the caller falls back to the
 * FTS arm. Every failure mode lands here, including an invalid or rotated key, a
 * provider 429, a 402 from an exceeded spend cap, and a network partition.
 */
async function embedQuery(deps: SearchDeps, query: string): Promise<number[] | null> {
  const key = `qembed:${query.trim().toLowerCase()}`;
  const hit = await cachedEmbedding(deps, key);
  if (hit) return hit;

  try {
    const [embedding] = await deps.provider.embedMany([query]);
    if (!embedding) return null;
    if (deps.cache) await deps.cache.set(key, embedding, deps.queryEmbedTtlMs).catch(() => {});
    return embedding;
  } catch (err) {
    deps.logger?.warn("query embedding failed; serving keyword results", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface SearchInput {
  siteId: string;
  query: string;
  filters: SearchFilters;
  topK?: number;
}

/**
 * Fuse ranked lists by Reciprocal Rank Fusion: each item scores `sum 1/(k+rank)`
 * across the lists it appears in (rank is 1-based position). Deduplicates by
 * chunk id and returns best-first. Pure and order-deterministic.
 */
export function rrfFuse(
  lists: readonly RetrievedChunk[][],
  k: number,
): { chunk: RetrievedChunk; score: number }[] {
  const scored = new Map<string, { chunk: RetrievedChunk; score: number }>();
  for (const list of lists) {
    list.forEach((chunk, i) => {
      const rrf = 1 / (k + i + 1);
      const current = scored.get(chunk.id);
      if (current) current.score += rrf;
      else scored.set(chunk.id, { chunk, score: rrf });
    });
  }
  return [...scored.values()].sort((a, b) => b.score - a.score);
}

function titleFromPath(path: string): string {
  const last = path.split("/").filter(Boolean).at(-1) ?? path;
  return last.replace(/[-_]/g, " ").replace(/\.(md|mdx)$/i, "");
}

function toHit(
  chunk: RetrievedChunk,
  score: number,
  baseUrl: string,
  apiBasePath: string,
): SearchHit {
  const isEndpoint = chunk.kind === "endpoint";
  const hash = chunk.anchor ? `#${chunk.anchor}` : "";
  const url = isEndpoint ? `${baseUrl}${apiBasePath}${hash}` : `${baseUrl}${chunk.path}${hash}`;
  return {
    id: chunk.id,
    kind: chunk.kind,
    title: chunk.headerPath.at(-1) ?? titleFromPath(chunk.path),
    snippet: chunk.text.replace(/\s+/g, " ").trim().slice(0, 200),
    url,
    anchor: chunk.anchor,
    headerPath: chunk.headerPath,
    method: isEndpoint ? chunk.method : null,
    path: isEndpoint ? chunk.path : null,
    score,
  };
}

/** What the vector arm produced, and whether it was supposed to produce more. */
interface VectorArm {
  chunks: RetrievedChunk[];
  degraded: boolean;
}

export async function hybridSearch(deps: SearchDeps, input: SearchInput): Promise<SearchResult> {
  const k = deps.rrfK ?? 60;
  const topK = input.topK ?? 8;
  const pool = Math.max(topK * 4, 20);

  // The vector arm is only *expected* to contribute when an embedding key is
  // configured. When it is expected and the embedding fails, we mark the result
  // degraded and carry on with the FTS arm. `store.vectorSearch` is deliberately
  // left uncaught: that is the database, and its loss is fatal to both arms.
  const expected = deps.provider.hasEmbedding();
  const vectorArm: Promise<VectorArm> = expected
    ? embedQuery(deps, input.query).then(async (embedding) => {
        if (!embedding) return { chunks: [], degraded: true };
        const chunks = await deps.store.vectorSearch({
          siteId: input.siteId,
          filters: input.filters,
          embedding,
          limit: pool,
        });
        return { chunks, degraded: false };
      })
    : Promise.resolve<VectorArm>({ chunks: [], degraded: false });

  const ftsArm = deps.store.ftsSearch({
    siteId: input.siteId,
    filters: input.filters,
    query: input.query,
    limit: pool,
  });

  const [vector, fts] = await Promise.all([vectorArm, ftsArm]);
  const fused = rrfFuse([vector.chunks, fts], k);
  const baseUrl = deps.baseUrl ?? "";
  const apiBasePath = deps.apiBasePath ?? "/api-reference";
  return {
    hits: fused.slice(0, topK).map(({ chunk, score }) => toHit(chunk, score, baseUrl, apiBasePath)),
    degraded: vector.degraded,
  };
}
