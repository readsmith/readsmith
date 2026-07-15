import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  type McpPage,
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
import { createCache, resolveCacheConfig } from "@readsmith/cache";
import { siteBasePath, siteOrigin } from "@readsmith/config";
import {
  type Db,
  type SearchChunkRow,
  ftsSearchChunks,
  insertAiQuery,
  insertPageFeedback,
  setAiQueryFeedback,
  vectorSearchChunks,
} from "@readsmith/db";
import type { NormalizedSpec, SearchFilters } from "@readsmith/model";
import { logSearchQuery } from "./analytics.js";
import { getDb } from "./db.js";
import { type Bundle, getBundle, loadBundleForSite, loadSiteVersions } from "./site.js";

/**
 * Composes the AI services the API routes call, from @readsmith/ai (provider,
 * retrieval, agent, MCP) + @readsmith/db (repos) + the bundle (chunks, spec).
 * This is the host wiring; @readsmith/api and @readsmith/ai stay host-agnostic.
 * Server-only, memoized. Returns null with no DB (docs-only).
 */

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
        sections: filters.sections,
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
        sections: filters.sections,
      });
      return rows.map(toRetrieved);
    },
  };
}

/** Instance-wide AI defaults (JSON, same shape as docs.yaml `ai:`): applied when a site configures nothing. */
function envAiDefaults(): unknown {
  const raw = process.env.READSMITH_AI_DEFAULTS;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    console.warn("[readsmith] READSMITH_AI_DEFAULTS is not valid JSON; ignoring");
    return null;
  }
}

function build(
  siteId: string,
  bundle: Bundle,
  aiOverride?: unknown,
  defaultVersion?: string,
): AiServices | null {
  const db = getDb();
  if (!db) return null; // docs-only: no server search/ask.

  // Retrieval hard-filters by version. A multi-version site indexes its default
  // version under its real id (not 'current'), so that is the base filter here;
  // the reader's active version (sent by the shell) overrides it per request.
  const baseFilters: SearchFilters = {
    version: defaultVersion ?? DEFAULT_FILTERS.version,
    locale: DEFAULT_FILTERS.locale,
  };

  const site = bundle.site;
  const apiRef = bundle.apiReference;

  let provider: ModelProvider = NULL_PROVIDER;
  let aiConfig = null as ReturnType<typeof resolveAiConfig>;
  try {
    aiConfig = resolveAiConfig(aiOverride ?? site.ai ?? envAiDefaults());
    if (aiConfig) provider = createModelProvider(aiConfig, envKeySource());
  } catch (err) {
    console.warn("[readsmith] AI config invalid; search degrades to full-text only:", err);
    provider = NULL_PROVIDER;
    aiConfig = null;
  }

  const search: SearchDeps = {
    store: retrievalStore(db),
    provider,
    // Deep links compose as origin + prefixed path (spec subpath-hosting SP-2):
    // chunk paths already carry the base path, the reference path does not.
    baseUrl: siteOrigin(site.url),
    apiBasePath: siteBasePath(site.url) + (site.apiReference?.path ?? "/api-reference"),
    rrfK: aiConfig?.search.rrfK,
    // Query-embedding cache (RT-5): repeats within the TTL skip the provider.
    // In-memory by default; swap CACHE_DRIVER to a shared store when hosted.
    cache: createCache(resolveCacheConfig(process.env)),
    queryEmbedTtlMs: 60_000,
    // A failing embedding provider degrades search to keyword-only rather than
    // taking it down. Say so in the log, once per query, so an operator can see
    // a dead key or an exhausted spend cap without reading the client.
    logger: {
      warn: (message, fields) => console.warn(`[readsmith] ${message}`, fields ?? ""),
    },
  };
  const topK = aiConfig?.search.topK ?? 8;

  const capabilities: AiCapabilities = {
    search: true, // DB present; FTS works even with no key
    vectorSearch: provider.hasEmbedding(),
    askAi: provider.hasChat() && (aiConfig?.askAi.enabled ?? false),
  };

  const filtersFrom = (input: { version?: string; locale?: string }): SearchFilters => ({
    version: input.version ?? baseFilters.version,
    locale: input.locale ?? baseFilters.locale,
  });

  // MCP over the SDK's web-standard Streamable-HTTP transport, read-only. A
  // session is created on the initialize request and routed by the mcp-session-id
  // header thereafter; the event store backs the client's resumption GET stream.
  // In-process is correct for single-instance self-host; the hosted phase backs
  // these with a shared store so any instance serves any session.
  const mcpSpec = apiRef?.spec ?? null;
  // Public pages become the docs filesystem for list_docs / get_page. Unlisted
  // and noindex pages are excluded, matching what the site exposes elsewhere.
  const mcpPages: McpPage[] = site.build.pages
    .filter((p) => !p.hidden && !p.noindex)
    .map((p) => ({
      title: p.title || p.slug || p.url,
      path: p.url,
      ...(p.description ? { description: p.description } : {}),
      markdown: p.rawMd,
    }));
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const mcp = async (request: Request): Promise<Response> => {
    const sessionId = request.headers.get("mcp-session-id") ?? undefined;
    const existing = sessions.get(sessionId ?? "");
    if (existing) return existing.handleRequest(request);

    // The one write tool is guarded per session on the unauthenticated /mcp:
    // path is validated in the tool, comment is capped, and a session can only
    // submit so many reports before it is refused.
    let feedbackCount = 0;
    const server = createMcpServer({
      search,
      siteId,
      filters: baseFilters,
      spec: mcpSpec,
      pages: mcpPages,
      feedback: async ({ path, helpful, comment }) => {
        if (feedbackCount >= 20) throw new Error("Feedback limit reached for this session.");
        feedbackCount++;
        await insertPageFeedback(db, {
          id: globalThis.crypto.randomUUID(),
          siteId,
          path,
          helpful,
          comment,
        });
      },
      // Skills ride along as resources: connected agents discover and read
      // them without installing anything (spec agent-skills SK-20).
      skills: site.build.skills ?? [],
      siteUrl: site.url,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => globalThis.crypto.randomUUID(),
      eventStore: new InMemoryEventStore(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
      onsessionclosed: (id: string) => {
        sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    return transport.handleRequest(request);
  };

  return {
    capabilities,
    async search(input) {
      const result = await hybridSearch(search, {
        siteId,
        query: input.query,
        filters: filtersFrom(input),
        topK,
      });
      // The search-gaps dataset: fire-and-forget, never on the response path.
      logSearchQuery({
        siteId,
        query: input.query,
        resultsCount: result.hits.length,
        version: input.version,
        locale: input.locale,
      });
      return result;
    },
    async ask(input) {
      // The assistant may be scoped to a subset of sections (config); the free
      // search box above is not, so this restriction lives on the ask path only.
      const filters = { ...filtersFrom(input), sections: aiConfig?.askAi.sections };
      const { result, completion } = askDocs(
        {
          provider,
          search,
          siteName: site.name,
          bounds: aiConfig?.askAi,
          topK,
          instructions: aiConfig?.askAi.instructions,
        },
        { siteId, query: input.query, filters },
      );

      // A minimal SSE the vanilla reading-shell island consumes: text deltas as
      // they stream, then the cited sources, then done (carrying the query id for
      // feedback). Logging happens once the answer resolves (never blocks the
      // stream).
      const queryId = globalThis.crypto.randomUUID();
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: unknown) =>
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          try {
            for await (const delta of result.textStream) send({ type: "text", delta });
          } catch {
            send({ type: "error", message: "The answer could not be completed." });
          }
          try {
            const c = await completion;
            send({ type: "sources", sources: c.sources });
            insertAiQuery(db, {
              id: queryId,
              siteId,
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
            }).catch((err) => console.warn("[readsmith] ai_queries log failed:", err));
          } catch {
            /* completion failed; the client already has the text or an error */
          }
          send({ type: "done", id: queryId });
          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
        },
      });
    },
    async feedback(input) {
      await setAiQueryFeedback(db, { id: input.id, feedback: input.value });
    },
    mcp,
  };
}

/**
 * Services are built per bundle object: the parsed-site LRU hands back the
 * same object while a deployment serves, and a pointer flip parses a new one,
 * so a WeakMap keyed on the bundle rebuilds services exactly when the content
 * they embed (chunks, spec, skills, ai config) actually changed - and old
 * entries die with their bundles.
 */
const perBundle = new WeakMap<Bundle, Map<string, AiServices | null>>();

/**
 * The AI services for one site's current deployment (null = no DB or nothing
 * deployed). A host that owns model selection (hosted tiers) passes an `ai`
 * override, same shape as docs.yaml `ai:`; variants cache side by side under
 * the same bundle and die with it.
 */
export async function getAiServicesForSite(
  siteId: string,
  options: { ai?: unknown } = {},
): Promise<AiServices | null> {
  // A multi-version site has no 'current' lane; load its default version's
  // bundle (for the site-level AI config, spec, pages) and use that version as
  // the retrieval base filter. Single-version sites resolve to 'current' as before.
  const versions = await loadSiteVersions(siteId);
  const defaultVersion = versions?.default;
  const bundle = await loadBundleForSite(siteId, defaultVersion);
  if (!bundle) return null;
  let variants = perBundle.get(bundle);
  if (!variants) {
    variants = new Map();
    perBundle.set(bundle, variants);
  }
  const key = options.ai === undefined ? "" : JSON.stringify(options.ai);
  if (!variants.has(key)) variants.set(key, build(siteId, bundle, options.ai, defaultVersion));
  return variants.get(key) ?? null;
}

/** The default site's AI services (the single-site app's path). */
export async function getAiServices(): Promise<AiServices | null> {
  const bundle = await getBundle().catch(() => null);
  if (!bundle) return null;
  let variants = perBundle.get(bundle);
  if (!variants) {
    variants = new Map();
    perBundle.set(bundle, variants);
  }
  if (!variants.has("")) variants.set("", build("default", bundle));
  return variants.get("") ?? null;
}
