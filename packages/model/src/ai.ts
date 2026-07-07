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
  snippet: z.string(),
  url: z.string(),
  anchor: z.string().nullable(),
  headerPath: z.array(z.string()),
  method: z.string().nullable(),
  path: z.string().nullable(),
  score: z.number(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;
