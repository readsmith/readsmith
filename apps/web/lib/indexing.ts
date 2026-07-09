import {
  type IndexStore,
  type ModelProvider,
  type SourceChunk,
  createModelProvider,
  envKeySource,
  indexChunks,
  resolveAiConfig,
} from "@readsmith/ai";
import {
  type Db,
  defineJob,
  deleteChunksNotIn,
  listChunkHashes,
  upsertDocChunks,
  upsertSite,
} from "@readsmith/db";
import { z } from "zod";
import type { ApiReference, Site } from "./site";
import { getApiReference, getSite } from "./site";

/**
 * `embed.index` as a pg-boss job: re-index the compiled bundle's chunks into
 * `doc_chunks`. The CLI (`pnpm ai:index`) runs the same work inline for v1
 * self-host; this job is the trigger the M2 GitHub App enqueues on publish. The
 * indexing composition (bundle -> source chunks -> IndexStore) lives here, shared
 * by both.
 */

const SITE_ID = "default";

/** The queue definition. Callers enqueue by name; the worker registers the handler. */
export const embedIndexJob = defineJob({
  name: "embed.index",
  schema: z.object({ siteId: z.string().optional() }).passthrough(),
});

/** A provider that reports no capabilities: FTS-only indexing (null embeddings). */
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

function buildSourceChunks(site: Site, apiReference: ApiReference | null): SourceChunk[] {
  const docs: SourceChunk[] = site.build.searchChunks.map((c) => ({
    id: c.id,
    kind: "doc",
    endpointId: null,
    pageId: c.page_id ?? null,
    path: c.path,
    headerPath: c.header_path ?? [],
    anchor: c.anchor ?? null,
    method: null,
    text: c.text,
  }));
  const endpoints: SourceChunk[] = apiReference
    ? apiReference.spec.operations.map((op) => ({
        id: `endpoint:${op.id}`,
        kind: "endpoint",
        endpointId: null,
        pageId: null,
        path: op.path,
        headerPath: op.tags.length > 0 ? [op.tags[0] ?? ""] : [],
        anchor: op.id,
        method: op.method,
        text: [op.method, op.path, op.summary ?? "", op.tags.join(" ")].join(" ").trim(),
      }))
    : [];
  return [...docs, ...endpoints];
}

/** Re-index the current bundle into `doc_chunks` (incremental, FTS-only without a key). */
export async function indexBundle(db: Db): Promise<void> {
  const site = await getSite();
  const apiRef = await getApiReference();
  await upsertSite(db, { id: SITE_ID, name: site.name });

  let provider: ModelProvider = NULL_PROVIDER;
  try {
    const cfg = resolveAiConfig(site.ai ?? null);
    if (cfg) provider = createModelProvider(cfg, envKeySource());
  } catch {
    provider = NULL_PROVIDER;
  }

  const store: IndexStore = {
    listChunkHashes: (siteId) => listChunkHashes(db, { siteId }),
    upsertChunks: ({ siteId, chunks }) => upsertDocChunks(db, { siteId, chunks }),
    deleteChunksNotIn: ({ siteId, keepIds }) => deleteChunksNotIn(db, { siteId, keepIds }),
  };

  await indexChunks(
    { store, provider },
    { siteId: SITE_ID, version: "current", locale: "en", chunks: buildSourceChunks(site, apiRef) },
  );
}
