/**
 * The dependency contract the API is constructed with. Routes talk to these
 * ports, never to a concrete driver, so the same routes run under any host that
 * can satisfy them (a Node server, an edge runtime). Each host wires its own
 * implementations. This is the seam that keeps the API runtime-agnostic.
 */

/**
 * The minimal query surface the API needs. Deliberately narrower than any one
 * driver: a Node Postgres client satisfies it structurally, and so can an
 * edge-compatible client, without the API depending on either.
 */
export interface ApiDatabase {
  query<T = Record<string, unknown>>(q: {
    text: string;
    values: readonly unknown[];
  }): Promise<T[]>;
}

import type { SearchHit } from "@readsmith/model";

/** Which rungs of the AI degradation ladder are live (host-computed from DB + keys). */
export interface AiCapabilities {
  /** Search API available (DB present). */
  search: boolean;
  /** Vector arm live (embedding key present); false = FTS-only. */
  vectorSearch: boolean;
  /** Ask-AI available (chat key present + enabled). */
  askAi: boolean;
}

/**
 * The AI surface the routes call, host-agnostic. The host composes it from
 * `@readsmith/ai` + `@readsmith/db` + a resolved provider, so the API package
 * itself stays free of ai-sdk/mcp/pg. `ask` and `mcp` return HTTP-ready
 * responses (streaming / transport specifics live in the host).
 */
export interface AiServices {
  capabilities: AiCapabilities;
  /** Hybrid search for the command palette (no LLM). */
  search(input: { query: string; version?: string; locale?: string }): Promise<SearchHit[]>;
  /** Start an Ask-AI turn: a streamed (SSE) Response; logs to ai_queries on finish. */
  ask(input: { query: string; version?: string; locale?: string }): Promise<Response>;
  /** Record a reader's thumbs signal on a logged query. */
  feedback(input: { id: string; value: number }): Promise<void>;
  /** Handle an MCP Streamable-HTTP request (the host wires the transport). */
  mcp(request: Request): Promise<Response>;
}

/** Everything a host injects when constructing the API. */
export interface ApiDeps {
  /** The database, or null when the host runs without persistence (docs-only). */
  db: ApiDatabase | null;
  /** The AI services, or null when AI is not configured (docs-only / FTS handled inside). */
  ai: AiServices | null;
}
