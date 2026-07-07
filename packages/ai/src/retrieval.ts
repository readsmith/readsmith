import type { SearchFilters, SearchHit } from "@readsmith/model";
import type { ModelProvider } from "./provider.js";

/**
 * Hybrid retrieval: run the vector and FTS arms concurrently, fuse by Reciprocal
 * Rank Fusion, map to `SearchHit`. Every arm is hard-filtered by version/locale
 * (the parity feature). With no embedding key the vector arm is empty and RRF
 * degenerates to FTS through the same code path. No LLM is involved, so this
 * powers the instant command palette.
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

export interface SearchDeps {
  store: RetrievalStore;
  provider: ModelProvider;
  /** Prefix for built links (default relative: ""). */
  baseUrl?: string;
  /** Where the API reference is served (default "/api-reference"). */
  apiBasePath?: string;
  /** RRF constant k (default 60, the standard). */
  rrfK?: number;
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

export async function hybridSearch(deps: SearchDeps, input: SearchInput): Promise<SearchHit[]> {
  const k = deps.rrfK ?? 60;
  const topK = input.topK ?? 8;
  const pool = Math.max(topK * 4, 20);

  const vectorArm = deps.provider.hasEmbedding()
    ? deps.provider.embedMany([input.query]).then(([embedding]) =>
        embedding
          ? deps.store.vectorSearch({
              siteId: input.siteId,
              filters: input.filters,
              embedding,
              limit: pool,
            })
          : [],
      )
    : Promise.resolve<RetrievedChunk[]>([]);

  const ftsArm = deps.store.ftsSearch({
    siteId: input.siteId,
    filters: input.filters,
    query: input.query,
    limit: pool,
  });

  const [vector, fts] = await Promise.all([vectorArm, ftsArm]);
  const fused = rrfFuse([vector, fts], k);
  const baseUrl = deps.baseUrl ?? "";
  const apiBasePath = deps.apiBasePath ?? "/api-reference";
  return fused.slice(0, topK).map(({ chunk, score }) => toHit(chunk, score, baseUrl, apiBasePath));
}
