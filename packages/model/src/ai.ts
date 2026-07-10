import { z } from "zod";

/**
 * AI-layer boundary contracts (M3): the shapes that cross a process boundary -
 * returned by the search API and the MCP tools, or passed as query scope. The
 * retrieval index rows, the Ask-AI agent, and the MCP server all speak these.
 * Provider keys and model plumbing live in `@readsmith/ai`, never here.
 */

/** Whether a retrievable chunk is prose or an API operation. */
export const chunkKindSchema = z.enum(["doc", "endpoint"]);
export type ChunkKind = z.infer<typeof chunkKindSchema>;

/**
 * The version/locale scope of a query. Every retrieval hard-filters by these
 * (the "version/locale-aware results" parity feature). v1 defaults to the single
 * current version and English; M2 versioning and later localization widen it.
 */
export const searchFiltersSchema = z.object({
  version: z.string().default("current"),
  locale: z.string().default("en"),
});
export type SearchFilters = z.infer<typeof searchFiltersSchema>;

/**
 * One search result. `url` + `anchor` form a working deep link; `headerPath` is
 * the breadcrumb; endpoint hits additionally carry `method`/`path` so the command
 * palette renders the tinted method pill. Returned by `/api/search` and the MCP
 * `search_docs` tool, and used as grounding by the Ask-AI agent.
 */
export const searchHitSchema = z.object({
  id: z.string(),
  kind: chunkKindSchema,
  title: z.string(),
  /** A short preview for the command palette. Never grounding for a model. */
  snippet: z.string(),
  /**
   * The full chunk text, present only when the caller asks for it. Agents need
   * it: a 200-character preview truncates mid-sentence, and a model grounded on
   * one will confidently report that the docs omit whatever sat at character 201.
   * The palette omits it so a keystroke does not ship kilobytes.
   */
  text: z.string().optional(),
  url: z.string(),
  anchor: z.string().nullable(),
  headerPath: z.array(z.string()),
  method: z.string().nullable(),
  path: z.string().nullable(),
  score: z.number(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

/**
 * A search response. `degraded` is true when the vector arm was expected to
 * contribute (an embedding key is configured) but failed at request time, so
 * these hits are keyword-only. It reports *runtime* health, which a config-time
 * capability flag cannot: a site with a working key still degrades when the
 * provider is down, rate-limited, or past its spend cap. The UI uses it to say so
 * rather than silently serving worse results.
 */
export const searchResultSchema = z.object({
  hits: z.array(searchHitSchema),
  degraded: z.boolean(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;
