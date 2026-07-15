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
import type { ApiReference, Site } from "./site.js";
import { loadBundleForSite, loadSiteVersions } from "./site.js";

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

const store = (db: Db): IndexStore => ({
  // Each call carries its version/locale lane, so the diff and prune touch only
  // that version's chunks (FR-14).
  listChunkHashes: ({ siteId, version, locale }) =>
    listChunkHashes(db, { siteId, versionId: version, locale }),
  upsertChunks: ({ siteId, chunks }) => upsertDocChunks(db, { siteId, chunks }),
  deleteChunksNotIn: ({ siteId, version, locale, keepIds }) =>
    deleteChunksNotIn(db, { siteId, versionId: version, locale, keepIds }),
});

function providerFor(site: Site): ModelProvider {
  try {
    const cfg = resolveAiConfig(site.ai ?? null);
    return cfg ? createModelProvider(cfg, envKeySource()) : NULL_PROVIDER;
  } catch {
    return NULL_PROVIDER;
  }
}

/**
 * Re-index a site into `doc_chunks` (incremental, FTS-only without a key). A
 * multi-version site indexes each version into its own lane (version_id), so a
 * search on one version never returns another's chunks; a single-version site
 * indexes the default bundle as `current`, exactly as before.
 */
export async function indexBundle(db: Db, siteId = SITE_ID): Promise<void> {
  const versions = await loadSiteVersions(siteId);
  const lanes = versions
    ? versions.list.map((v) => ({ versionId: v.id }))
    : [{ versionId: undefined as string | undefined }];

  let named = false;
  for (const lane of lanes) {
    const bundle = await loadBundleForSite(siteId, lane.versionId);
    if (!bundle) continue; // nothing deployed in this lane yet
    const site = bundle.site;
    if (!named) {
      await upsertSite(db, { id: siteId, name: site.name });
      named = true;
    }
    await indexChunks(
      { store: store(db), provider: providerFor(site) },
      {
        siteId,
        version: lane.versionId ?? "current",
        locale: "en",
        chunks: buildSourceChunks(site, bundle.apiReference),
      },
    );
  }
}
