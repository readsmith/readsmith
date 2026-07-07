import type { Db } from "./client.js";
import {
  type AiQueryRow,
  type ApiEndpointRow,
  type ApiSpecRow,
  type DocChunkRow,
  type NewAiQuery,
  type NewDocChunk,
  type NewEndpoint,
  type SiteRow,
  aiQueryRowSchema,
  apiEndpointRowSchema,
  apiSpecRowSchema,
  docChunkRowSchema,
  siteRowSchema,
} from "./schema.js";
import { type SqlQuery, joinSql, sql } from "./sql.js";

/**
 * Typed access layer for the base tables. Every function uses the parameterized
 * `sql` tag (no interpolated SQL) and validates rows against their Zod schema
 * before returning, so callers receive checked data, not raw driver output.
 */

export async function upsertSite(db: Db, input: { id: string; name: string }): Promise<SiteRow> {
  const row = await db.one(sql`
    INSERT INTO app.sites (id, name) VALUES (${input.id}, ${input.name})
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
    RETURNING id, name, created_at`);
  return siteRowSchema.parse(row);
}

export async function getSite(db: Db, id: string): Promise<SiteRow | null> {
  const row = await db.one(sql`SELECT id, name, created_at FROM app.sites WHERE id = ${id}`);
  return row ? siteRowSchema.parse(row) : null;
}

/** Find an already-ingested spec by its idempotency key, or null. */
export async function findSpecByHash(
  db: Db,
  input: { siteId: string; sourcePath: string; contentHash: string },
): Promise<ApiSpecRow | null> {
  const row = await db.one(sql`
    SELECT id, site_id, source_path, content_hash, version,
           raw_ref, bundled_ref, normalized_ref, info, created_at
    FROM app.api_specs
    WHERE site_id = ${input.siteId}
      AND source_path = ${input.sourcePath}
      AND content_hash = ${input.contentHash}`);
  return row ? apiSpecRowSchema.parse(row) : null;
}

export interface NewSpec {
  id: string;
  siteId: string;
  sourcePath: string;
  contentHash: string;
  rawRef: string | null;
  bundledRef: string | null;
  normalizedRef: string | null;
  info: Record<string, unknown>;
}

/**
 * Insert a spec, assigning the next version for its (site, source_path). Runs in
 * a transaction so the version read and the insert cannot race. Idempotency
 * short-circuits on the content hash before allocating a version.
 */
export async function insertSpec(db: Db, input: NewSpec): Promise<ApiSpecRow> {
  return db.tx(async (tx) => {
    const existing = await findSpecByHash(tx, input);
    if (existing) return existing;

    const next = await tx.one<{ version: number }>(sql`
      SELECT coalesce(max(version), 0) + 1 AS version
      FROM app.api_specs
      WHERE site_id = ${input.siteId} AND source_path = ${input.sourcePath}`);
    const version = next?.version ?? 1;

    const row = await tx.one(sql`
      INSERT INTO app.api_specs
        (id, site_id, source_path, content_hash, version, raw_ref, bundled_ref, normalized_ref, info)
      VALUES
        (${input.id}, ${input.siteId}, ${input.sourcePath}, ${input.contentHash}, ${version},
         ${input.rawRef}, ${input.bundledRef}, ${input.normalizedRef}, ${JSON.stringify(input.info)}::jsonb)
      RETURNING id, site_id, source_path, content_hash, version,
                raw_ref, bundled_ref, normalized_ref, info, created_at`);
    return apiSpecRowSchema.parse(row);
  });
}

/** Replace the endpoint rows for a spec (bulk insert), returning the count. */
export async function insertEndpoints(
  db: Db,
  input: { specId: string; siteId: string; endpoints: readonly NewEndpoint[] },
): Promise<number> {
  if (input.endpoints.length === 0) return 0;
  const rows: SqlQuery[] = input.endpoints.map(
    (e) => sql`(${e.id}, ${input.specId}, ${input.siteId}, ${e.operationId}, ${e.method},
      ${e.path}, ${e.tags}, ${e.summary}, ${e.deprecated}, ${e.searchText})`,
  );
  await db.query(sql`
    INSERT INTO app.api_endpoints
      (id, spec_id, site_id, operation_id, method, path, tags, summary, deprecated, search_text)
    VALUES ${joinSql(rows, ", ")}`);
  return input.endpoints.length;
}

export async function listEndpointsBySpec(db: Db, specId: string): Promise<ApiEndpointRow[]> {
  const rows = await db.query(sql`
    SELECT id, spec_id, site_id, operation_id, method, path, tags, summary,
           deprecated, search_text, created_at
    FROM app.api_endpoints
    WHERE spec_id = ${specId}
    ORDER BY path, method`);
  return rows.map((r) => apiEndpointRowSchema.parse(r));
}

/** Full-text search over endpoints for a site (the FTS half M3 augments with vectors). */
export async function searchEndpoints(
  db: Db,
  input: { siteId: string; query: string; limit?: number },
): Promise<ApiEndpointRow[]> {
  const limit = input.limit ?? 20;
  const rows = await db.query(sql`
    SELECT id, spec_id, site_id, operation_id, method, path, tags, summary,
           deprecated, search_text, created_at
    FROM app.api_endpoints
    WHERE site_id = ${input.siteId}
      AND search_tsv @@ websearch_to_tsquery('english', ${input.query})
    ORDER BY ts_rank(search_tsv, websearch_to_tsquery('english', ${input.query})) DESC
    LIMIT ${limit}`);
  return rows.map((r) => apiEndpointRowSchema.parse(r));
}

// --- M3: doc-chunk index + Ask-AI query log ---

/**
 * Format an embedding as a pgvector text literal (`[a,b,c]`), or pass null
 * through. The literal is bound as a parameter and cast `::halfvec` in SQL, so no
 * value is ever interpolated into the statement text (injection guard holds).
 */
export function vectorLiteral(v: number[] | null): string | null {
  return v === null ? null : `[${v.join(",")}]`;
}

/**
 * Upsert chunk rows (docs and endpoints). Keyed by the stable chunk id, so a
 * re-index overwrites in place; `embedding` may be null (FTS-only). Callers diff
 * by `content_hash` first (see `listChunkHashes`) to skip unchanged chunks.
 */
export async function upsertDocChunks(
  db: Db,
  input: { siteId: string; chunks: readonly NewDocChunk[] },
): Promise<number> {
  if (input.chunks.length === 0) return 0;
  const rows: SqlQuery[] = input.chunks.map((c) => {
    const emb = vectorLiteral(c.embedding);
    return sql`(${c.id}, ${input.siteId}, ${c.kind}, ${c.endpointId}, ${c.pageId}, ${c.path},
      ${c.headerPath}, ${c.anchor}, ${c.method}, ${c.versionId}, ${c.locale}, ${c.contentHash},
      ${c.text}, ${emb}::halfvec)`;
  });
  await db.query(sql`
    INSERT INTO app.doc_chunks
      (id, site_id, kind, endpoint_id, page_id, path, header_path, anchor, method,
       version_id, locale, content_hash, text, embedding)
    VALUES ${joinSql(rows, ", ")}
    ON CONFLICT (id) DO UPDATE SET
      kind = EXCLUDED.kind, endpoint_id = EXCLUDED.endpoint_id, page_id = EXCLUDED.page_id,
      path = EXCLUDED.path, header_path = EXCLUDED.header_path, anchor = EXCLUDED.anchor,
      method = EXCLUDED.method, version_id = EXCLUDED.version_id, locale = EXCLUDED.locale,
      content_hash = EXCLUDED.content_hash, text = EXCLUDED.text, embedding = EXCLUDED.embedding`);
  return input.chunks.length;
}

/** The (id, contentHash) of every chunk for a site: the incremental-diff basis. */
export async function listChunkHashes(
  db: Db,
  input: { siteId: string },
): Promise<{ id: string; contentHash: string }[]> {
  const rows = await db.query<{ id: string; content_hash: string }>(sql`
    SELECT id, content_hash FROM app.doc_chunks WHERE site_id = ${input.siteId}`);
  return rows.map((r) => ({ id: r.id, contentHash: r.content_hash }));
}

/** Delete chunks for a site whose id is not in the current set (removed pages). */
export async function deleteChunksNotIn(
  db: Db,
  input: { siteId: string; keepIds: readonly string[] },
): Promise<number> {
  const res = await db.query<{ id: string }>(sql`
    DELETE FROM app.doc_chunks
    WHERE site_id = ${input.siteId} AND id <> ALL(${input.keepIds as string[]})
    RETURNING id`);
  return res.length;
}

/** Log an answered Ask-AI query. `model` carries provider+model ids, never a key. */
export async function insertAiQuery(db: Db, input: NewAiQuery): Promise<AiQueryRow> {
  const row = await db.one(sql`
    INSERT INTO app.ai_queries
      (id, site_id, query, filters, retrieved_chunk_ids, answer, cited_ids, model,
       input_tokens, output_tokens, cost_estimate, latency_ms)
    VALUES (${input.id}, ${input.siteId}, ${input.query}, ${JSON.stringify(input.filters)}::jsonb,
      ${input.retrievedChunkIds}, ${input.answer}, ${input.citedIds},
      ${JSON.stringify(input.model)}::jsonb, ${input.inputTokens}, ${input.outputTokens},
      ${input.costEstimate}, ${input.latencyMs})
    RETURNING id, site_id, query, filters, retrieved_chunk_ids, answer, cited_ids, model,
              input_tokens, output_tokens, cost_estimate, latency_ms, feedback, created_at`);
  return aiQueryRowSchema.parse(row);
}

/** Record a reader's thumbs signal (1 up, -1 down) on a logged query. */
export async function setAiQueryFeedback(
  db: Db,
  input: { id: string; feedback: number },
): Promise<void> {
  await db.query(
    sql`UPDATE app.ai_queries SET feedback = ${input.feedback} WHERE id = ${input.id}`,
  );
}

/** Purge query-log rows older than the retention window (default 90 days). */
export async function purgeAiQueries(db: Db, input: { olderThanDays: number }): Promise<number> {
  const res = await db.query<{ id: string }>(sql`
    DELETE FROM app.ai_queries
    WHERE created_at < now() - make_interval(days => ${input.olderThanDays})
    RETURNING id`);
  return res.length;
}
