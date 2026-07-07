import {
  type Db,
  type NewEndpoint,
  type Storage,
  findSpecByHash,
  insertEndpoints,
  insertSpec,
  sql,
} from "@readsmith/db";
import {
  type Diagnostic,
  type NormalizedSpec,
  contentHash,
  normalizedSpecSchema,
} from "@readsmith/model";
import { endpointSearchText } from "./derive.js";
import { type SpecChange, diffSpecs } from "./diff.js";
import { type NormalizedContent, normalizeDocument } from "./normalize.js";
import { parseAndBundle } from "./parse.js";

/**
 * Ingest orchestrator: fetch, parse+bundle, normalize, derive, diff, persist. IO
 * is injected (read the source, a database, a blob store) so it is host-agnostic
 * and testable. Idempotent by content hash; deterministic. The heavy JSON goes to
 * storage (the row holds refs); api_endpoints rows are denormalized for list and
 * search. The normalized blob is version-independent, so no post-insert update is
 * needed: NormalizedSpec is reconstructed from the row's id/version/hash plus the
 * stored content.
 */

export interface IngestDeps {
  db: Db;
  storage: Storage;
  /**
   * Read a spec by its source path. Return the raw bytes (for hashing/storage)
   * and, when the source is on disk, its filesystem path so external multi-file
   * `$ref`s can be bundled. Omit `fsPath` for in-memory or single-file sources.
   */
  readSource: (sourcePath: string) => Promise<{ raw: string; fsPath?: string }>;
}

export interface IngestInput {
  siteId: string;
  sourcePath: string;
}

export interface IngestResult {
  specId: string;
  version: number;
  endpoints: number;
  /** True when identical bytes were already ingested (no new version). */
  skipped: boolean;
  diagnostics: Diagnostic[];
  changes: SpecChange[];
}

/** The stored, version-independent content blob (NormalizedSpec minus row metadata). */
type ContentBlob = Omit<NormalizedContent, "diagnostics">;

export async function ingestSpec(deps: IngestDeps, input: IngestInput): Promise<IngestResult> {
  const { db, storage } = deps;
  const source = await deps.readSource(input.sourcePath);
  const raw = source.raw;
  const hash = contentHash(raw);

  const existing = await findSpecByHash(db, {
    siteId: input.siteId,
    sourcePath: input.sourcePath,
    contentHash: hash,
  });
  if (existing) {
    return {
      specId: existing.id,
      version: existing.version,
      endpoints: 0,
      skipped: true,
      diagnostics: [],
      changes: [],
    };
  }

  const parsed = await parseAndBundle({
    raw,
    source: input.sourcePath,
    ...(source.fsPath ? { path: source.fsPath } : {}),
  });
  const content = parsed.doc
    ? normalizeDocument(parsed.doc, input.sourcePath)
    : emptyContent(input.sourcePath);
  const diagnostics = [...parsed.diagnostics, ...content.diagnostics];

  const specId = contentHash(`${input.siteId}:${input.sourcePath}:${hash}`).slice(0, 24);
  const blob: ContentBlob = {
    info: content.info,
    servers: content.servers,
    securitySchemes: content.securitySchemes,
    tags: content.tags,
    operations: content.operations,
    schemas: content.schemas,
  };

  const rawRef = await storage.put(raw);
  const normalizedRef = await storage.put(JSON.stringify(blob));

  const row = await insertSpec(db, {
    id: specId,
    siteId: input.siteId,
    sourcePath: input.sourcePath,
    contentHash: hash,
    rawRef,
    bundledRef: null,
    normalizedRef,
    info: content.info as Record<string, unknown>,
  });

  const spec: NormalizedSpec = {
    specId: row.id,
    siteId: row.site_id,
    version: row.version,
    sourceHash: row.content_hash,
    ...blob,
  };

  // Validate at the persistence boundary; a normalization defect fails soft
  // (spec row is kept, endpoints are skipped) rather than failing the job.
  const valid = normalizedSpecSchema.safeParse(spec);
  if (!valid.success) {
    diagnostics.push({
      severity: "error",
      code: "normalize-invalid",
      message: `Normalized spec failed validation: ${valid.error.message}`,
      source: input.sourcePath,
    });
    return { specId, version: row.version, endpoints: 0, skipped: false, diagnostics, changes: [] };
  }

  const changes = await diffAgainstPrior(deps, input, spec);

  const endpoints: NewEndpoint[] = content.operations.map((op) => ({
    id: `${specId}:${op.id}`,
    operationId: op.id,
    method: op.method,
    path: op.path,
    tags: op.tags,
    summary: op.summary ?? null,
    deprecated: op.deprecated,
    searchText: endpointSearchText(op),
  }));
  await insertEndpoints(db, { specId, siteId: input.siteId, endpoints });

  return {
    specId,
    version: row.version,
    endpoints: endpoints.length,
    skipped: false,
    diagnostics,
    changes,
  };
}

async function diffAgainstPrior(
  deps: IngestDeps,
  input: IngestInput,
  next: NormalizedSpec,
): Promise<SpecChange[]> {
  const prior = await deps.db.one<{
    id: string;
    site_id: string;
    version: number;
    content_hash: string;
    normalized_ref: string | null;
  }>(sql`
    SELECT id, site_id, version, content_hash, normalized_ref
    FROM app.api_specs
    WHERE site_id = ${input.siteId} AND source_path = ${input.sourcePath} AND version < ${next.version}
    ORDER BY version DESC
    LIMIT 1`);
  if (!prior || !prior.normalized_ref) return [];

  const blob = JSON.parse((await deps.storage.get(prior.normalized_ref)).toString()) as ContentBlob;
  const prev: NormalizedSpec = {
    specId: prior.id,
    siteId: prior.site_id,
    version: prior.version,
    sourceHash: prior.content_hash,
    ...blob,
  };
  return diffSpecs(prev, next);
}

function emptyContent(source: string): NormalizedContent {
  return {
    info: { title: "API", version: "0.0.0" },
    servers: [],
    securitySchemes: {},
    tags: [],
    operations: [],
    schemas: {},
    diagnostics: [
      {
        severity: "error",
        code: "no-document",
        message: "Spec could not be parsed; nothing was ingested.",
        source,
      },
    ],
  };
}
