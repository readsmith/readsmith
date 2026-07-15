import { contentHash } from "@readsmith/model";
import type { ModelProvider } from "./provider.js";

/**
 * `embed.index`: turn the compiled bundle's chunks (docs + endpoints) into
 * `doc_chunks` rows. The host loads the source chunks from the bundle and backs
 * the `IndexStore` port with the DB repos; this module owns the deterministic
 * pipeline: diff by content hash, embed only what changed, upsert, prune removed.
 * No embedding key = FTS-only rows (null embedding), not an error.
 */

/** A chunk as it comes from the bundle (no version/hash/embedding yet). */
export interface SourceChunk {
  id: string;
  kind: "doc" | "endpoint";
  endpointId: string | null;
  pageId: string | null;
  path: string;
  headerPath: string[];
  anchor: string | null;
  method: string | null;
  text: string;
}

/** A chunk ready to persist (the host adapter maps this to a DB row). */
export interface IndexChunk extends SourceChunk {
  versionId: string;
  locale: string;
  contentHash: string;
  embedding: number[] | null;
}

/**
 * The persistence port (backed by `@readsmith/db` repos in the host). The diff
 * and prune are scoped to one (site, version, locale) lane so re-indexing a
 * version never reads or deletes another version's chunks (FR-14).
 */
export interface IndexStore {
  listChunkHashes(input: {
    siteId: string;
    version: string;
    locale: string;
  }): Promise<{ id: string; contentHash: string }[]>;
  upsertChunks(input: { siteId: string; chunks: readonly IndexChunk[] }): Promise<number>;
  deleteChunksNotIn(input: {
    siteId: string;
    version: string;
    locale: string;
    keepIds: readonly string[];
  }): Promise<number>;
}

export interface IndexInput {
  siteId: string;
  version: string;
  locale: string;
  chunks: readonly SourceChunk[];
}

export interface IndexResult {
  total: number;
  /** New or content-changed chunks (re-embedded + upserted). */
  changed: number;
  /** Unchanged chunks skipped (same id + content hash). */
  skipped: number;
  /** How many embeddings were computed (0 on the FTS-only path). */
  embedded: number;
  /** Rows pruned because their chunk no longer exists in the source. */
  deleted: number;
  /** Whether vector embeddings were written (false = FTS-only). */
  vectors: boolean;
}

export interface IndexDeps {
  store: IndexStore;
  provider: ModelProvider;
  log?: (message: string) => void;
}

/**
 * Index a site's chunks incrementally. Deterministic given a fixed embedding
 * model: chunk ids + content hashes are stable, so a re-run on an unchanged
 * bundle is a no-op and a single edited page re-embeds only its chunks.
 */
export async function indexChunks(deps: IndexDeps, input: IndexInput): Promise<IndexResult> {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});

  const existing = new Map(
    (
      await store.listChunkHashes({
        siteId: input.siteId,
        version: input.version,
        locale: input.locale,
      })
    ).map((r) => [r.id, r.contentHash]),
  );

  const withHash = input.chunks.map((chunk) => ({ chunk, hash: contentHash(chunk.text) }));
  const changed = withHash.filter(({ chunk, hash }) => existing.get(chunk.id) !== hash);
  const skipped = withHash.length - changed.length;

  const hasEmbedding = provider.hasEmbedding();
  let embeddings: number[][] = [];
  if (hasEmbedding && changed.length > 0) {
    embeddings = await provider.embedMany(changed.map(({ chunk }) => chunk.text));
  }

  const toUpsert: IndexChunk[] = changed.map(({ chunk, hash }, i) => ({
    ...chunk,
    versionId: input.version,
    locale: input.locale,
    contentHash: hash,
    embedding: hasEmbedding ? (embeddings[i] ?? null) : null,
  }));

  await store.upsertChunks({ siteId: input.siteId, chunks: toUpsert });
  const deleted = await store.deleteChunksNotIn({
    siteId: input.siteId,
    version: input.version,
    locale: input.locale,
    keepIds: input.chunks.map((c) => c.id),
  });

  const result: IndexResult = {
    total: input.chunks.length,
    changed: changed.length,
    skipped,
    embedded: hasEmbedding ? changed.length : 0,
    deleted,
    vectors: hasEmbedding,
  };
  log(
    `[embed.index] site=${input.siteId} total=${result.total} changed=${result.changed} ` +
      `skipped=${result.skipped} embedded=${result.embedded} deleted=${result.deleted} ` +
      `vectors=${result.vectors}`,
  );
  return result;
}
