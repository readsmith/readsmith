import { z } from "zod";

/**
 * Zod row schemas for the base tables. Reads at the persistence boundary are
 * validated against these before use (the schema-first rule), so a column type
 * drift or a null where none is expected fails loudly at the edge, not deep in a
 * consumer. The API-reference *meaning* of these rows is owned by the ingest
 * spec; here they are just the persisted shapes.
 */
export const siteRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.date(),
});
export type SiteRow = z.infer<typeof siteRowSchema>;

export const apiSpecRowSchema = z.object({
  id: z.string(),
  site_id: z.string(),
  source_path: z.string(),
  content_hash: z.string(),
  version: z.number().int(),
  raw_ref: z.string().nullable(),
  bundled_ref: z.string().nullable(),
  normalized_ref: z.string().nullable(),
  info: z.record(z.string(), z.unknown()),
  created_at: z.date(),
});
export type ApiSpecRow = z.infer<typeof apiSpecRowSchema>;

export const apiEndpointRowSchema = z.object({
  id: z.string(),
  spec_id: z.string(),
  site_id: z.string(),
  operation_id: z.string().nullable(),
  method: z.string(),
  path: z.string(),
  tags: z.array(z.string()),
  summary: z.string().nullable(),
  deprecated: z.boolean(),
  search_text: z.string().nullable(),
  created_at: z.date(),
});
export type ApiEndpointRow = z.infer<typeof apiEndpointRowSchema>;

/** A new endpoint to persist (id is derived by the caller from the stable op id). */
export interface NewEndpoint {
  id: string;
  operationId: string | null;
  method: string;
  path: string;
  tags: string[];
  summary: string | null;
  deprecated: boolean;
  searchText: string | null;
}

/**
 * A retrievable chunk row (M3, migration 0002). Reads omit `embedding` and
 * `search_tsv` (large/opaque, not needed by consumers); retrieval computes
 * scores in SQL and returns the metadata that forms the citation.
 */
export const docChunkRowSchema = z.object({
  id: z.string(),
  site_id: z.string(),
  kind: z.string(),
  endpoint_id: z.string().nullable(),
  page_id: z.string().nullable(),
  path: z.string(),
  header_path: z.array(z.string()),
  anchor: z.string().nullable(),
  method: z.string().nullable(),
  version_id: z.string(),
  locale: z.string(),
  content_hash: z.string(),
  text: z.string(),
  created_at: z.date(),
});
export type DocChunkRow = z.infer<typeof docChunkRowSchema>;

/**
 * A chunk row as returned by retrieval (vector or FTS). Omits `embedding`/tsv
 * (opaque, not needed downstream); the caller derives a citation + snippet from
 * these fields and fuses the two arms by rank.
 */
export const searchChunkRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  page_id: z.string().nullable(),
  path: z.string(),
  header_path: z.array(z.string()),
  anchor: z.string().nullable(),
  method: z.string().nullable(),
  text: z.string(),
});
export type SearchChunkRow = z.infer<typeof searchChunkRowSchema>;

/** A chunk to index. `embedding` is null when no embedding provider is configured. */
export interface NewDocChunk {
  id: string;
  kind: "doc" | "endpoint";
  endpointId: string | null;
  pageId: string | null;
  path: string;
  headerPath: string[];
  anchor: string | null;
  method: string | null;
  versionId: string;
  locale: string;
  contentHash: string;
  text: string;
  embedding: number[] | null;
}

/**
 * An Ask-AI query-log row (M3). Never holds a key, headers, or reader identity.
 * Usage columns (`input_tokens`/`output_tokens`/`cost_estimate`) are observed for
 * BYOK spend visibility; they are logged, never enforced.
 */
export const aiQueryRowSchema = z.object({
  id: z.string(),
  site_id: z.string(),
  query: z.string(),
  filters: z.record(z.string(), z.unknown()),
  retrieved_chunk_ids: z.array(z.string()),
  answer: z.string().nullable(),
  cited_ids: z.array(z.string()),
  model: z.record(z.string(), z.unknown()),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  cost_estimate: z.number().nullable(),
  latency_ms: z.number().int().nullable(),
  feedback: z.number().int().nullable(),
  created_at: z.date(),
});
export type AiQueryRow = z.infer<typeof aiQueryRowSchema>;

/** A new Ask-AI query to log. `model` carries provider+model ids, never a key. */
export interface NewAiQuery {
  id: string;
  siteId: string;
  query: string;
  filters: Record<string, unknown>;
  retrievedChunkIds: string[];
  answer: string | null;
  citedIds: string[];
  model: Record<string, unknown>;
  inputTokens: number | null;
  outputTokens: number | null;
  costEstimate: number | null;
  latencyMs: number | null;
}
