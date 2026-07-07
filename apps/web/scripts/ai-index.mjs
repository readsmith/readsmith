// Indexes the compiled bundle's chunks (docs + API endpoints) into `doc_chunks`
// (the M3 `embed.index` work, run as a CLI for v1 self-host: `pnpm ai:index`).
// Incremental by content hash; `--reindex` truncates first for an embedding-model
// change. FTS-only when no embedding key is configured (null embeddings).
import { join } from "node:path";
import { createModelProvider, envKeySource, indexChunks, resolveAiConfig } from "@readsmith/ai";
import {
  createDb,
  deleteChunksNotIn,
  hasDatabase,
  listChunkHashes,
  loadDbConfig,
  runMigrations,
  upsertDocChunks,
  upsertSite,
} from "@readsmith/db";
import { createBundleStore, resolveStorageConfig } from "@readsmith/storage";

const SITE_ID = "default";
const REINDEX = process.argv.includes("--reindex");

// A provider that reports no capabilities: FTS-only indexing (null embeddings).
const NULL_PROVIDER = {
  hasChat: () => false,
  hasEmbedding: () => false,
  embedMany: async () => {
    throw new Error("no embedding provider configured");
  },
  chat: () => {
    throw new Error("no chat provider configured");
  },
};

function buildSourceChunks(site, apiReference) {
  const docs = (site.build.searchChunks ?? []).map((c) => ({
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
  const endpoints = apiReference
    ? apiReference.spec.operations.map((op) => ({
        id: `endpoint:${op.id}`,
        kind: "endpoint",
        endpointId: null,
        pageId: null,
        path: op.path,
        headerPath: op.tags?.length ? [op.tags[0]] : [],
        anchor: op.id,
        method: op.method,
        text: [op.method, op.path, op.summary ?? "", (op.tags ?? []).join(" ")].join(" ").trim(),
      }))
    : [];
  return [...docs, ...endpoints];
}

async function main() {
  if (!hasDatabase()) {
    console.error("[readsmith] ai:index needs DATABASE_URL (the persistence backbone).");
    process.exit(1);
  }

  const store = createBundleStore(
    resolveStorageConfig(process.env, join(process.cwd(), ".readsmith")),
  );
  const bytes = await store.get("bundle.json");
  if (!bytes) {
    console.error("[readsmith] no content bundle; run the content build first (pnpm build).");
    process.exit(1);
  }
  const { site, apiReference } = JSON.parse(bytes.toString("utf8"));

  const db = createDb(loadDbConfig());
  try {
    await runMigrations(db);
    await upsertSite(db, { id: SITE_ID, name: site.name ?? "Readsmith" });
    if (REINDEX) {
      await db.exec("TRUNCATE app.doc_chunks");
      console.log("[readsmith] ai:index: truncated doc_chunks (--reindex).");
    }

    const aiConfig = resolveAiConfig(site.ai ?? null);
    const provider = aiConfig ? createModelProvider(aiConfig, envKeySource()) : NULL_PROVIDER;

    const indexStore = {
      listChunkHashes: (siteId) => listChunkHashes(db, { siteId }),
      upsertChunks: ({ siteId, chunks }) => upsertDocChunks(db, { siteId, chunks }),
      deleteChunksNotIn: ({ siteId, keepIds }) => deleteChunksNotIn(db, { siteId, keepIds }),
    };

    const chunks = buildSourceChunks(site, apiReference);
    const result = await indexChunks(
      { store: indexStore, provider, log: (m) => console.log(m) },
      { siteId: SITE_ID, version: "current", locale: "en", chunks },
    );
    console.log(`[readsmith] ai:index done: ${JSON.stringify(result)}`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error("[readsmith] ai:index failed:", err);
  process.exit(1);
});
