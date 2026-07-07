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
