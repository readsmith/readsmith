import type { Db } from "./client.js";
import {
  type ApiEndpointRow,
  type ApiSpecRow,
  type NewEndpoint,
  type SiteRow,
  apiEndpointRowSchema,
  apiSpecRowSchema,
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
