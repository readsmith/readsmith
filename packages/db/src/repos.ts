import type { Db } from "./client.js";
import {
  type AiQueryRow,
  type ApiEndpointRow,
  type ApiSpecRow,
  type DeploymentRow,
  type DocChunkRow,
  type GitConnectionRow,
  type NewAiQuery,
  type NewDocChunk,
  type NewEndpoint,
  type PageFeedbackRow,
  type SearchChunkRow,
  type SiteRow,
  aiQueryRowSchema,
  apiEndpointRowSchema,
  apiSpecRowSchema,
  deploymentRowSchema,
  docChunkRowSchema,
  gitConnectionRowSchema,
  pageFeedbackRowSchema,
  searchChunkRowSchema,
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

/**
 * Vector kNN over the chunk index (cosine), hard-filtered by site/version/locale.
 * Rows without an embedding (FTS-only) are excluded. Returns rows best-first; the
 * caller fuses ranks. The query embedding is bound as a parameter, cast
 * `::halfvec` in SQL (no interpolation).
 */
export async function vectorSearchChunks(
  db: Db,
  input: {
    siteId: string;
    versionId: string;
    locale: string;
    embedding: number[];
    limit: number;
  },
): Promise<SearchChunkRow[]> {
  const emb = vectorLiteral(input.embedding);
  const rows = await db.query(sql`
    SELECT id, kind, page_id, path, header_path, anchor, method, text
    FROM app.doc_chunks
    WHERE site_id = ${input.siteId} AND version_id = ${input.versionId} AND locale = ${input.locale}
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${emb}::halfvec
    LIMIT ${input.limit}`);
  return rows.map((r) => searchChunkRowSchema.parse(r));
}

/** Full-text (websearch) over the chunk index, hard-filtered by site/version/locale. */
export async function ftsSearchChunks(
  db: Db,
  input: { siteId: string; versionId: string; locale: string; query: string; limit: number },
): Promise<SearchChunkRow[]> {
  const rows = await db.query(sql`
    SELECT id, kind, page_id, path, header_path, anchor, method, text
    FROM app.doc_chunks
    WHERE site_id = ${input.siteId} AND version_id = ${input.versionId} AND locale = ${input.locale}
      AND search_tsv @@ websearch_to_tsquery('english', ${input.query})
    ORDER BY ts_rank(search_tsv, websearch_to_tsquery('english', ${input.query})) DESC
    LIMIT ${input.limit}`);
  return rows.map((r) => searchChunkRowSchema.parse(r));
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

// --- M2: git connections + deployments ---

const GIT_CONNECTION_COLUMNS = sql`id, site_id, provider, installation_id, repo, branch,
  last_synced_sha, created_at, updated_at`;

const DEPLOYMENT_COLUMNS = sql`id, site_id, version_id, kind, git_ref, commit_sha, build_seq,
  bundle_ref, bundle_hash, url, status, is_current, created_at, published_at, expires_at`;

export interface NewGitConnection {
  id: string;
  siteId: string;
  provider: string;
  /** Null for PAT connections (no App installation exists). */
  installationId: string | null;
  repo: string;
  branch: string;
}

/** One connection per (site, repo); re-binding refreshes provider/installation/branch. */
export async function upsertGitConnection(
  db: Db,
  input: NewGitConnection,
): Promise<GitConnectionRow> {
  const row = await db.one(sql`
    INSERT INTO app.git_connections (id, site_id, provider, installation_id, repo, branch)
    VALUES (${input.id}, ${input.siteId}, ${input.provider}, ${input.installationId},
            ${input.repo}, ${input.branch})
    ON CONFLICT (site_id, repo) DO UPDATE SET
      provider = EXCLUDED.provider,
      installation_id = EXCLUDED.installation_id,
      branch = EXCLUDED.branch,
      updated_at = now()
    RETURNING ${GIT_CONNECTION_COLUMNS}`);
  return gitConnectionRowSchema.parse(row);
}

/** The site's connection (v1: at most one; newest wins if several exist). */
export async function getGitConnection(db: Db, siteId: string): Promise<GitConnectionRow | null> {
  const row = await db.one(sql`
    SELECT ${GIT_CONNECTION_COLUMNS} FROM app.git_connections
    WHERE site_id = ${siteId}
    ORDER BY updated_at DESC
    LIMIT 1`);
  return row ? gitConnectionRowSchema.parse(row) : null;
}

/** Every site's newest connection (the poller sweeps all of them). */
export async function listGitConnections(db: Db): Promise<GitConnectionRow[]> {
  const rows = await db.query(sql`
    SELECT DISTINCT ON (site_id) ${GIT_CONNECTION_COLUMNS} FROM app.git_connections
    ORDER BY site_id, updated_at DESC`);
  return rows.map((row) => gitConnectionRowSchema.parse(row));
}

/** Record the last commit actually built (also the polling comparand). */
export async function setLastSyncedSha(db: Db, input: { id: string; sha: string }): Promise<void> {
  await db.query(sql`
    UPDATE app.git_connections
    SET last_synced_sha = ${input.sha}, updated_at = now()
    WHERE id = ${input.id}`);
}

export interface NewDeployment {
  siteId: string;
  versionId?: string;
  kind?: string;
  gitRef: string | null;
  commitSha: string;
}

/**
 * Open a deployment for a starting build: allocates the per-site monotonic
 * `build_seq` under a site-level lock (so two concurrent builds cannot race the
 * same sequence) and inserts the row as `building`. The id derives from the
 * sequence, so it is deterministic and human-traceable.
 */
export async function insertDeployment(db: Db, input: NewDeployment): Promise<DeploymentRow> {
  return db.tx(async (tx) => {
    await tx.query(sql`SELECT id FROM app.sites WHERE id = ${input.siteId} FOR UPDATE`);
    const next = await tx.one<{ seq: number }>(sql`
      SELECT coalesce(max(build_seq), 0) + 1 AS seq
      FROM app.deployments WHERE site_id = ${input.siteId}`);
    const seq = next?.seq ?? 1;
    const id = `dep:${input.siteId}:${seq}`;
    const row = await tx.one(sql`
      INSERT INTO app.deployments (id, site_id, version_id, kind, git_ref, commit_sha, build_seq, status)
      VALUES (${id}, ${input.siteId}, ${input.versionId ?? "current"}, ${input.kind ?? "production"},
              ${input.gitRef}, ${input.commitSha}, ${seq}, 'building')
      RETURNING ${DEPLOYMENT_COLUMNS}`);
    return deploymentRowSchema.parse(row);
  });
}

export async function markDeploymentFailed(db: Db, id: string): Promise<void> {
  await db.query(sql`UPDATE app.deployments SET status = 'failed' WHERE id = ${id}`);
}

/**
 * Atomic publish with the supersede guard: record the verified artifact, then
 * flip `is_current` only if no *newer* build (higher `build_seq`) already holds
 * the pointer. A stale build that finishes late lands as `superseded` and never
 * moves the pointer backward. Runs under a site-level lock; the partial unique
 * index on (site_id, version_id) WHERE is_current backstops any race.
 */
export async function publishDeployment(
  db: Db,
  input: { id: string; bundleRef: string; bundleHash: string },
): Promise<{ flipped: boolean; row: DeploymentRow }> {
  return db.tx(async (tx) => {
    const target = await tx.one<{ site_id: string; version_id: string; build_seq: number }>(sql`
      SELECT site_id, version_id, build_seq FROM app.deployments WHERE id = ${input.id}`);
    if (!target) throw new Error(`unknown deployment: ${input.id}`);
    await tx.query(sql`SELECT id FROM app.sites WHERE id = ${target.site_id} FOR UPDATE`);
    await tx.query(sql`
      UPDATE app.deployments
      SET bundle_ref = ${input.bundleRef}, bundle_hash = ${input.bundleHash}, published_at = now()
      WHERE id = ${input.id}`);
    const newer = await tx.one<{ id: string }>(sql`
      SELECT id FROM app.deployments
      WHERE site_id = ${target.site_id} AND version_id = ${target.version_id}
        AND is_current AND build_seq > ${target.build_seq}`);
    if (newer) {
      const row = await tx.one(sql`
        UPDATE app.deployments SET status = 'superseded' WHERE id = ${input.id}
        RETURNING ${DEPLOYMENT_COLUMNS}`);
      return { flipped: false, row: deploymentRowSchema.parse(row) };
    }
    await tx.query(sql`
      UPDATE app.deployments SET is_current = false
      WHERE site_id = ${target.site_id} AND version_id = ${target.version_id} AND is_current`);
    const row = await tx.one(sql`
      UPDATE app.deployments SET is_current = true, status = 'ready' WHERE id = ${input.id}
      RETURNING ${DEPLOYMENT_COLUMNS}`);
    // Cross-instance pointer invalidation; delivered on commit, never on abort.
    await tx.query(sql`SELECT pg_notify('readsmith_deployment_published', ${target.site_id})`);
    return { flipped: true, row: deploymentRowSchema.parse(row) };
  });
}

/**
 * Rollback (and forward redeploy): explicitly repoint `is_current` at a prior
 * `ready` snapshot. Deliberately not guarded by `build_seq` - moving backward is
 * the point - but only a `ready` row with an artifact can become current.
 */
export async function repointCurrent(
  db: Db,
  input: { siteId: string; versionId?: string; deploymentId: string },
): Promise<DeploymentRow> {
  const versionId = input.versionId ?? "current";
  return db.tx(async (tx) => {
    await tx.query(sql`SELECT id FROM app.sites WHERE id = ${input.siteId} FOR UPDATE`);
    const target = await tx.one(sql`
      SELECT ${DEPLOYMENT_COLUMNS} FROM app.deployments
      WHERE id = ${input.deploymentId} AND site_id = ${input.siteId} AND version_id = ${versionId}`);
    if (!target) throw new Error(`unknown deployment: ${input.deploymentId}`);
    const parsed = deploymentRowSchema.parse(target);
    if (parsed.status !== "ready" || parsed.bundle_ref === null) {
      throw new Error(
        `deployment ${input.deploymentId} is not a publishable snapshot (status: ${parsed.status})`,
      );
    }
    await tx.query(sql`
      UPDATE app.deployments SET is_current = false
      WHERE site_id = ${input.siteId} AND version_id = ${versionId} AND is_current`);
    const row = await tx.one(sql`
      UPDATE app.deployments SET is_current = true WHERE id = ${input.deploymentId}
      RETURNING ${DEPLOYMENT_COLUMNS}`);
    // Rollback is a flip too: same cross-instance invalidation signal.
    await tx.query(sql`SELECT pg_notify('readsmith_deployment_published', ${input.siteId})`);
    return deploymentRowSchema.parse(row);
  });
}

export async function getCurrentDeployment(
  db: Db,
  input: { siteId: string; versionId?: string },
): Promise<DeploymentRow | null> {
  const row = await db.one(sql`
    SELECT ${DEPLOYMENT_COLUMNS} FROM app.deployments
    WHERE site_id = ${input.siteId} AND version_id = ${input.versionId ?? "current"} AND is_current`);
  return row ? deploymentRowSchema.parse(row) : null;
}

/** Deployment history, newest first (the rollback list). */
export async function listDeployments(
  db: Db,
  input: { siteId: string; limit?: number },
): Promise<DeploymentRow[]> {
  const rows = await db.query(sql`
    SELECT ${DEPLOYMENT_COLUMNS} FROM app.deployments
    WHERE site_id = ${input.siteId}
    ORDER BY build_seq DESC
    LIMIT ${input.limit ?? 20}`);
  return rows.map((r) => deploymentRowSchema.parse(r));
}

/**
 * Retention: mark non-current rollback candidates beyond the `keepLast` most
 * recent as `pruned`, and report which artifact refs are no longer referenced by
 * any live row (content-addressed refs dedupe, so a ref shared with a live or
 * current deployment must never be deleted). The current deployment is never
 * pruned. Artifact deletion is the caller's concern.
 */
export async function pruneSuperseded(
  db: Db,
  input: { siteId: string; keepLast: number },
): Promise<{ prunedIds: string[]; unreferencedRefs: string[] }> {
  return db.tx(async (tx) => {
    await tx.query(sql`SELECT id FROM app.sites WHERE id = ${input.siteId} FOR UPDATE`);
    const candidates = await tx.query<{ id: string }>(sql`
      SELECT id FROM app.deployments
      WHERE site_id = ${input.siteId} AND NOT is_current AND status IN ('ready', 'superseded')
      ORDER BY build_seq DESC
      OFFSET ${input.keepLast}`);
    const ids = candidates.map((c) => c.id);
    if (ids.length === 0) return { prunedIds: [], unreferencedRefs: [] };
    await tx.query(sql`
      UPDATE app.deployments SET status = 'pruned' WHERE id = ANY(${ids})`);
    const refs = await tx.query<{ bundle_ref: string }>(sql`
      SELECT DISTINCT bundle_ref FROM app.deployments
      WHERE id = ANY(${ids}) AND bundle_ref IS NOT NULL
        AND bundle_ref NOT IN (
          SELECT bundle_ref FROM app.deployments
          WHERE site_id = ${input.siteId} AND status <> 'pruned' AND bundle_ref IS NOT NULL)`);
    return { prunedIds: ids, unreferencedRefs: refs.map((r) => r.bundle_ref) };
  });
}

/**
 * Record or clear the App installation covering a connected repo (driven by
 * `installation` webhooks). Matches case-insensitively (GitHub repo names are);
 * returns whether a connection existed to update.
 */
export async function setInstallationId(
  db: Db,
  input: { siteId: string; repo: string; installationId: string | null },
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(sql`
    UPDATE app.git_connections
    SET installation_id = ${input.installationId}, updated_at = now()
    WHERE site_id = ${input.siteId} AND lower(repo) = lower(${input.repo})
    RETURNING id`);
  return rows.length > 0;
}

// --- Analytics lite: search-gap log + page feedback ---

/** Log an answered search. Callers fire-and-forget: never on a response path. */
export async function insertSearchQuery(
  db: Db,
  input: {
    id: string;
    siteId: string;
    query: string;
    resultsCount: number;
    versionId?: string;
    locale?: string;
  },
): Promise<void> {
  await db.query(sql`
    INSERT INTO app.search_queries (id, site_id, query, results_count, zero_result, version_id, locale)
    VALUES (${input.id}, ${input.siteId}, ${input.query}, ${input.resultsCount},
            ${input.resultsCount === 0}, ${input.versionId ?? "current"}, ${input.locale ?? "en"})`);
}

/** Purge search logs older than the retention window (default 90 days). */
export async function purgeSearchQueries(
  db: Db,
  input: { olderThanDays: number },
): Promise<number> {
  const res = await db.query<{ id: string }>(sql`
    DELETE FROM app.search_queries
    WHERE created_at < now() - make_interval(days => ${input.olderThanDays})
    RETURNING id`);
  return res.length;
}

/** Record a reader's page-helpfulness signal. */
export async function insertPageFeedback(
  db: Db,
  input: { id: string; siteId: string; path: string; helpful: boolean; comment?: string | null },
): Promise<PageFeedbackRow> {
  const row = await db.one(sql`
    INSERT INTO app.page_feedback (id, site_id, path, helpful, comment)
    VALUES (${input.id}, ${input.siteId}, ${input.path}, ${input.helpful}, ${input.comment ?? null})
    RETURNING id, site_id, path, helpful, comment, created_at`);
  return pageFeedbackRowSchema.parse(row);
}

/** Purge feedback older than the retention window (default 90 days). */
export async function purgePageFeedback(db: Db, input: { olderThanDays: number }): Promise<number> {
  const res = await db.query<{ id: string }>(sql`
    DELETE FROM app.page_feedback
    WHERE created_at < now() - make_interval(days => ${input.olderThanDays})
    RETURNING id`);
  return res.length;
}
