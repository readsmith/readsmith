import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { normalizeDocument, parseAndBundle } from "@readsmith/api-reference";
import { createRegistry, themeToCss } from "@readsmith/components";
import {
  type ResolvedConfig,
  analyticsHeadHtml,
  contentRootOf,
  resolveConfig,
} from "@readsmith/config";
import { type AuthoredSkill, type RenderCache, type SiteBuild, assembleSite } from "@readsmith/mdx";
import {
  type Diagnostic,
  type NormalizedSpec,
  contentHash,
  normalizedSpecSchema,
} from "@readsmith/model";

/**
 * The compile: one deterministic path from a content directory to the bundle
 * the serving shell reads. Every step that contributes bytes to the served
 * site lives here, so the local prebuild script and the deploy job cannot
 * drift apart. Same content and same siteId always yield byte-identical
 * `bundleJson` and therefore the same `bundleHash` (the content address a
 * deployment stores the artifact under).
 */
export interface CompileSiteInput {
  /** Directory the operator points Readsmith at (config plus content). */
  contentDir: string;
  /** Stable site identity baked into the bundle; single-site installs use the default. */
  siteId?: string;
  /**
   * Optional page-render cache (see `openRenderCache` for the persisted one).
   * Purely an accelerator: with or without it, and warm or cold, the produced
   * `bundleJson` is byte-identical for the same content.
   */
  renderCache?: RenderCache;
  /**
   * Strict mode: when any page produces an error diagnostic, the result's
   * `bundle.site.build.ok` is false and callers must not publish or serve it.
   * Default (false) keeps the resilient behavior: build with diagnostics.
   */
  failOnError?: boolean;
  /**
   * Serve the site at this URL instead of the config's `site.url`. A host that
   * owns where a site is reachable (a multi-site install assigning domains)
   * passes the assigned URL here, so authored config never moves a site and a
   * domain change is exactly one rebuild with a new value. Affects everything
   * `site.url` affects: page URLs, the base path, canonical and OG metadata.
   */
  siteUrl?: string;
}

/** The API reference as it rides inside the bundle. */
export interface CompiledApiReference {
  spec: NormalizedSpec;
  path: string;
  label: string;
  layout: "single" | "pages";
}

/** The site envelope the serving shell hydrates (its `Site` shape). */
export interface CompiledSiteEnvelope {
  build: SiteBuild;
  name: string;
  branding: boolean;
  url?: string;
  description?: string;
  homeUrl?: string;
  logo?: ResolvedConfig["site"]["logo"];
  favicon?: ResolvedConfig["site"]["favicon"];
  /** Precompiled per-site brand theme, injected into <head> by the shell. */
  themeCss: string;
  /** Precompiled bring-your-own analytics tags; omitted when none configured. */
  analyticsHtml?: string;
  appearance: ResolvedConfig["appearance"];
  apiReference?: ResolvedConfig["apiReference"];
  footer?: ResolvedConfig["footer"];
  ai: unknown;
}

/** The whole immutable artifact: what `bundleJson` serializes. */
export interface ContentBundle {
  site: CompiledSiteEnvelope;
  apiReference: CompiledApiReference | null;
}

export interface CompileSiteResult {
  config: ResolvedConfig;
  contentRoot: string;
  bundle: ContentBundle;
  /** Canonical serialization; callers must store these exact bytes so the hash matches them. */
  bundleJson: string;
  /** Content hash of `bundleJson`: the artifact's content address. */
  bundleHash: string;
  /** Parse/normalize diagnostics for the API spec (empty when none is configured). */
  apiReferenceDiagnostics: Diagnostic[];
  /**
   * Paths actually re-rendered this compile (everything, on a cold cache).
   * Deliberately NOT part of the bundle: the artifact is normalized so warm and
   * cold builds of the same content stay byte-identical (the content address
   * must never depend on cache state).
   */
  rebuiltPages: string[];
}

interface ApiReferenceOutcome {
  reference: CompiledApiReference | null;
  diagnostics: Diagnostic[];
}

async function buildApiReference(
  config: ResolvedConfig,
  contentRoot: string,
  siteId: string,
): Promise<ApiReferenceOutcome> {
  if (!config.apiReference) return { reference: null, diagnostics: [] };
  const source = config.apiReference.spec;
  const specPath = join(contentRoot, source);
  let raw: string;
  try {
    raw = await readFile(specPath, "utf8");
  } catch {
    return {
      reference: null,
      diagnostics: [
        {
          severity: "warning",
          code: "api-spec-read",
          message: `could not read spec at ${source}`,
          source,
        },
      ],
    };
  }
  const parsed = await parseAndBundle({ raw, path: specPath, source });
  if (!parsed.doc) return { reference: null, diagnostics: parsed.diagnostics };
  const content = normalizeDocument(parsed.doc, source);
  const hash = contentHash(raw);
  const spec: NormalizedSpec = {
    specId: hash.slice(0, 16),
    siteId,
    version: 1,
    sourceHash: hash,
    info: content.info,
    servers: content.servers,
    securitySchemes: content.securitySchemes,
    tags: content.tags,
    operations: content.operations,
    schemas: content.schemas,
  };
  const diagnostics = [...parsed.diagnostics, ...content.diagnostics];
  if (!normalizedSpecSchema.safeParse(spec).success) {
    return {
      reference: null,
      diagnostics: [
        ...diagnostics,
        {
          severity: "warning",
          code: "api-spec-invalid",
          message: "normalized spec failed validation; skipping the API reference",
          source,
        },
      ],
    };
  }
  return {
    reference: {
      spec,
      path: config.apiReference.path,
      label: config.apiReference.label,
      layout: config.apiReference.layout,
    },
    diagnostics,
  };
}

/**
 * Snippet sources: `snippets/**` under the content root, keyed by their path
 * relative to that directory (the `<Snippet file="...">` prop). Reserved from
 * page discovery; read here, expanded at transform time.
 */
async function readSnippets(contentRoot: string): Promise<Record<string, string>> {
  const root = join(contentRoot, "snippets");
  if (!existsSync(root)) return {};
  const out: Record<string, string> = {};
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, key);
      else if (/\.(md|mdx)$/i.test(entry.name)) out[key] = await readFile(full, "utf8");
    }
  };
  await walk(root, "");
  return out;
}

/**
 * Authored agent skills: `.readsmith/skills/<name>/SKILL.md` (or the
 * `.mintlify/skills/` migration fallback when that is absent), plus a root
 * `skill.md`. Files are read up to one nested level (scripts/, references/,
 * assets/); validation happens in assembly, this just reads text.
 */
async function readSkills(contentRoot: string): Promise<AuthoredSkill[]> {
  const out: AuthoredSkill[] = [];
  let root: string | null = join(contentRoot, ".readsmith/skills");
  if (!existsSync(root)) {
    const mintlify = join(contentRoot, ".mintlify/skills");
    root = existsSync(mintlify) ? mintlify : null;
  }
  if (root) {
    const dirs = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const dir of dirs) {
      const skillRoot = join(root, dir.name);
      const files: AuthoredSkill["files"] = [];
      const entries = (await readdir(skillRoot, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        if (entry.isFile()) {
          files.push({
            path: entry.name,
            content: await readFile(join(skillRoot, entry.name), "utf8"),
          });
        } else if (entry.isDirectory()) {
          const nested = (await readdir(join(skillRoot, entry.name), { withFileTypes: true }))
            .filter((e) => e.isFile())
            .sort((a, b) => a.name.localeCompare(b.name));
          for (const file of nested) {
            files.push({
              path: `${entry.name}/${file.name}`,
              content: await readFile(join(skillRoot, entry.name, file.name), "utf8"),
            });
          }
        }
      }
      out.push({ dir: dir.name, source: relative(contentRoot, skillRoot), files });
    }
  }
  const rootFile = join(contentRoot, "skill.md");
  if (existsSync(rootFile)) {
    out.push({
      dir: null,
      source: "skill.md",
      files: [{ path: "SKILL.md", content: await readFile(rootFile, "utf8") }],
    });
  }
  return out;
}

/**
 * Compile a content directory into the immutable bundle: resolve config,
 * ingest the API spec (hybrid `openapi:` pages bind to its operations during
 * assembly), run the full page build, and wrap it all in the site envelope.
 * Pure with respect to its inputs: no clock, no randomness, no writes; the
 * caller decides where the bytes land.
 */
export async function compileSite(input: CompileSiteInput): Promise<CompileSiteResult> {
  const siteId = input.siteId ?? "default";
  const resolved = await resolveConfig(input.contentDir);
  const config = input.siteUrl
    ? { ...resolved, site: { ...resolved.site, url: input.siteUrl } }
    : resolved;
  const contentRoot = contentRootOf(input.contentDir, config);
  const { reference, diagnostics: apiReferenceDiagnostics } = await buildApiReference(
    config,
    contentRoot,
    siteId,
  );
  const build = await assembleSite({
    config,
    readPage: (path) => readFile(join(contentRoot, path), "utf8"),
    registry: createRegistry({ apiSpec: reference?.spec ?? null }),
    renderCache: input.renderCache,
    failOnError: input.failOnError,
    baseUrl: config.site.url,
    apiReference:
      reference && config.apiReference
        ? {
            spec: reference.spec,
            source: config.apiReference.spec,
            path: config.apiReference.path,
            layout: config.apiReference.layout,
            label: config.apiReference.label,
          }
        : null,
    skills: await readSkills(contentRoot),
    snippets: await readSnippets(contentRoot),
  });
  // The artifact must not remember how it was built: `rebuilt` varies with
  // cache warmth, so it is normalized out of the serialized bundle (and
  // returned separately) to keep the content address cache-independent.
  const site: CompiledSiteEnvelope = {
    build: { ...build, rebuilt: [] },
    name: config.site.name,
    branding: config.branding,
    url: config.site.url,
    description: config.site.description,
    homeUrl: config.site.homeUrl,
    logo: config.site.logo,
    favicon: config.site.favicon,
    themeCss: themeToCss(config.site.theme),
    analyticsHtml: analyticsHeadHtml(config.analytics),
    appearance: config.appearance,
    apiReference: config.apiReference,
    footer: config.footer,
    ai: config.ai ?? null,
  };
  const bundle: ContentBundle = { site, apiReference: reference };
  const bundleJson = JSON.stringify(bundle);
  return {
    config,
    contentRoot,
    bundle,
    bundleJson,
    bundleHash: contentHash(bundleJson),
    apiReferenceDiagnostics,
    rebuiltPages: build.rebuilt,
  };
}
