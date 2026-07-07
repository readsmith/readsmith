import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeDocument, parseAndBundle } from "@readsmith/api-reference";
import { type NormalizedSpec, contentHash, normalizedSpecSchema } from "@readsmith/model";
import { getSite } from "./site";

/**
 * Server-only, build-time. Turns the configured OpenAPI file into a NormalizedSpec
 * for rendering: parse + bundle + normalize, entirely in memory. The reference
 * page therefore needs no database (docs plus a spec file, zero services); the DB
 * persistence layer feeds later search, not this rendering. Memoized like the site.
 */
export interface ApiReference {
  spec: NormalizedSpec;
  path: string;
  label: string;
}

let cached: Promise<ApiReference | null> | null = null;

export function getApiReference(): Promise<ApiReference | null> {
  if (!cached) cached = build();
  return cached;
}

async function build(): Promise<ApiReference | null> {
  const site = await getSite();
  if (!site.apiReference) return null;

  const specPath = join(site.contentRoot, site.apiReference.spec);
  let raw: string;
  try {
    raw = await readFile(specPath, "utf8");
  } catch {
    console.warn(`[readsmith] api reference: could not read spec at ${site.apiReference.spec}`);
    return null;
  }

  const parsed = await parseAndBundle({ raw, path: specPath, source: site.apiReference.spec });
  if (!parsed.doc) {
    for (const d of parsed.diagnostics) console.warn(`  ${d.severity} ${d.code}: ${d.message}`);
    return null;
  }

  const content = normalizeDocument(parsed.doc, site.apiReference.spec);
  const hash = contentHash(raw);
  const spec: NormalizedSpec = {
    specId: hash.slice(0, 16),
    siteId: "default",
    version: 1,
    sourceHash: hash,
    info: content.info,
    servers: content.servers,
    securitySchemes: content.securitySchemes,
    tags: content.tags,
    operations: content.operations,
    schemas: content.schemas,
  };

  const valid = normalizedSpecSchema.safeParse(spec);
  if (!valid.success) {
    console.warn("[readsmith] api reference: normalized spec failed validation; skipping.");
    return null;
  }

  const diagnostics = [...parsed.diagnostics, ...content.diagnostics];
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.filter((d) => d.severity === "warning").length;
  if (errors > 0 || warnings > 0) {
    console.warn(
      `[readsmith] api reference: ${errors} error(s), ${warnings} warning(s), ${spec.operations.length} operation(s)`,
    );
  }

  return { spec, path: site.apiReference.path, label: site.apiReference.label };
}
