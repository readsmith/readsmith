import {
  type ModelProvider,
  type RetrievalStore,
  type RetrievedChunk,
  type SearchDeps,
  askDocs,
  createMcpServer,
  createModelProvider,
  envKeySource,
  hybridSearch,
  resolveAiConfig,
} from "@readsmith/ai";
import type { AiCapabilities, AiServices } from "@readsmith/api";
import {
  type Db,
  type SearchChunkRow,
  ftsSearchChunks,
  insertAiQuery,
  setAiQueryFeedback,
  vectorSearchChunks,
} from "@readsmith/db";
import type { NormalizedSpec, SearchFilters } from "@readsmith/model";

/** The subset of the MCP transport interface our one-shot bridge implements. */
interface OneShotTransport {
  start(): Promise<void>;
  send(message: unknown): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}
import { getDb } from "./db";
import { getApiReference, getSite } from "./site";

/**
 * Composes the AI services the API routes call, from @readsmith/ai (provider,
 * retrieval, agent, MCP) + @readsmith/db (repos) + the bundle (chunks, spec).
 * This is the host wiring; @readsmith/api and @readsmith/ai stay host-agnostic.
 * Server-only, memoized. Returns null with no DB (docs-only).
 */

const SITE_ID = "default";
const DEFAULT_FILTERS: SearchFilters = { version: "current", locale: "en" };

/** A provider that reports no capabilities: FTS-only search still works through it. */
const NULL_PROVIDER: ModelProvider = {
  hasChat: () => false,
  hasEmbedding: () => false,
  embedMany: async () => {
    throw new Error("no embedding provider configured");
  },
  chat: () => {
    throw new Error("no chat provider configured");
  },
};

function toRetrieved(row: SearchChunkRow): RetrievedChunk {
  return {
    id: row.id,
    kind: row.kind === "endpoint" ? "endpoint" : "doc",
    pageId: row.page_id,
    path: row.path,
    headerPath: row.header_path,
    anchor: row.anchor,
    method: row.method,
    text: row.text,
  };
}

function retrievalStore(db: Db): RetrievalStore {
  return {
    async vectorSearch({ siteId, filters, embedding, limit }) {
      const rows = await vectorSearchChunks(db, {
        siteId,
        versionId: filters.version,
        locale: filters.locale,
        embedding,
        limit,
      });
      return rows.map(toRetrieved);
    },
    async ftsSearch({ siteId, filters, query, limit }) {
      const rows = await ftsSearchChunks(db, {
        siteId,
        versionId: filters.version,
        locale: filters.locale,
        query,
        limit,
      });
      return rows.map(toRetrieved);
    },
  };
}

/** A minimal stateless bridge: dispatch one JSON-RPC message through a fresh server. */
function handleMcp(
  makeSpec: () => NormalizedSpec | null,
  search: SearchDeps,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    let message: unknown;
    try {
      message = await request.json();
    } catch {
      return new Response(null, { status: 400 });
    }
    const server = createMcpServer({
      search,
      siteId: SITE_ID,
      filters: DEFAULT_FILTERS,
      spec: makeSpec(),
    });
    const isRequest =
      typeof message === "object" &&
      message !== null &&
      "id" in message &&
      (message as { id: unknown }).id !== undefined;

    const responsePromise = new Promise<unknown>((resolve) => {
      const transport: OneShotTransport = {
        start: async () => {},
        send: async (msg) => resolve(msg),
        close: async () => {},
      };
      server
        .connect(transport as Parameters<typeof server.connect>[0])
        .then(() => transport.onmessage?.(message));
    });

    if (!isRequest) return new Response(null, { status: 202 }); // notification: ack
    return Response.json(await responsePromise);
  };
}

async function build(): Promise<AiServices | null> {
  const db = getDb();
  if (!db) return null; // docs-only: no server search/ask.

  const site = await getSite();
  const apiRef = await getApiReference();

  let provider: ModelProvider = NULL_PROVIDER;
  let aiConfig = null as ReturnType<typeof resolveAiConfig>;
  try {
    aiConfig = resolveAiConfig(site.ai ?? null);
    if (aiConfig) provider = createModelProvider(aiConfig, envKeySource());
  } catch (err) {
    console.warn("[readsmith] AI config invalid; search degrades to full-text only:", err);
    provider = NULL_PROVIDER;
    aiConfig = null;
  }

  const search: SearchDeps = {
    store: retrievalStore(db),
    provider,
    baseUrl: site.url ?? "",
    apiBasePath: site.apiReference?.path ?? "/api-reference",
    rrfK: aiConfig?.search.rrfK,
  };
  const topK = aiConfig?.search.topK ?? 8;

  const capabilities: AiCapabilities = {
    search: true, // DB present; FTS works even with no key
    vectorSearch: provider.hasEmbedding(),
    askAi: provider.hasChat() && (aiConfig?.askAi.enabled ?? false),
  };

  const filtersFrom = (input: { version?: string; locale?: string }): SearchFilters => ({
    version: input.version ?? DEFAULT_FILTERS.version,
    locale: input.locale ?? DEFAULT_FILTERS.locale,
  });

  const mcp = handleMcp(() => apiRef?.spec ?? null, search);

  return {
    capabilities,
    async search(input) {
      return hybridSearch(search, {
        siteId: SITE_ID,
        query: input.query,
        filters: filtersFrom(input),
        topK,
      });
    },
    async ask(input) {
      const filters = filtersFrom(input);
      const { result, completion } = askDocs(
        { provider, search, siteName: site.name, bounds: aiConfig?.askAi, topK },
        { siteId: SITE_ID, query: input.query, filters },
      );
      completion
        .then((c) =>
          insertAiQuery(db, {
            id: globalThis.crypto.randomUUID(),
            siteId: SITE_ID,
            query: input.query,
            filters,
            retrievedChunkIds: c.retrievedIds,
            answer: c.answer,
            citedIds: c.citedIds,
            model: { chat: aiConfig?.chat, embedding: aiConfig?.embedding },
            inputTokens: c.usage.inputTokens,
            outputTokens: c.usage.outputTokens,
            costEstimate: null,
            latencyMs: null,
          }),
        )
        .catch((err) => console.warn("[readsmith] ai_queries log failed:", err));
      return result.toUIMessageStreamResponse();
    },
    async feedback(input) {
      await setAiQueryFeedback(db, { id: input.id, feedback: input.value });
    },
    mcp,
  };
}

let cached: Promise<AiServices | null> | undefined;

export function getAiServices(): Promise<AiServices | null> {
  if (!cached) cached = build();
  return cached;
}
