import { posix } from "node:path";
import {
  type OperationContext,
  findOperation,
  operationToMarkdown,
  schemaToMarkdown,
} from "@readsmith/api-reference";
import { type Diagnostic, type Operation, contentHash } from "@readsmith/model";
import GithubSlugger from "github-slugger";
import type { Root } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";
import { parse as parseYaml } from "yaml";
import { parse } from "./parse.js";
import { type Chunk, type TocNode, project } from "./projections.js";
import {
  type ComponentRegistry,
  type IslandManifest,
  type RenderCache,
  type RenderResult,
  render,
} from "./render.js";
import { expandSnippetsAndVariables } from "./snippets.js";
import { buildJsonLd } from "./structured-data.js";
import { transform } from "./transform.js";

/**
 * P7 Assembly: the orchestrator. Runs every page through P1-P6 (rendering is
 * cached and dependency-aware), then does the site-level work that needs all
 * pages at once (nav finalization, cross-page link validation, sitemap, RSS,
 * agent-readiness outputs, search handoff) and assembles a deterministic build.
 *
 * Kept structurally decoupled from `@readsmith/config`: it accepts the resolved
 * config's shape, so a caller passes a ResolvedConfig directly without this
 * package importing that one (mirrors the `resolvePage` callback in P2).
 */

/** A resolved navigation node (matches the config package's output shape). */
export type NavNode =
  | { type: "page"; slug: string }
  | { type: "group"; label: string; children: NavNode[] };

export interface SitePage {
  /** Path relative to the content root, POSIX separators. */
  path: string;
  /** URL slug; the root index page has slug "". */
  slug: string;
}

/** A top-level navigation tab as consumed by assembly: a label and its nav subtree. */
export interface NavTab {
  label: string;
  nav: NavNode[];
}

/** The subset of a resolved config that assembly consumes. */
export interface SiteConfig {
  site: {
    name: string;
    url?: string;
    description?: string;
    author?: { name: string; url?: string };
    publisher?: { name: string; url?: string };
    theme?: Record<string, unknown>;
  };
  variables?: Record<string, unknown>;
  pages: SitePage[];
  nav: NavNode[];
  /** Top-level tabs, when configured. Each scopes its own sidebar navigation. */
  tabs?: NavTab[];
  /** Where the content root sits relative to the repository root ("." or "docs"). */
  content?: { root: string };
  /** Asset mounts, `from` content-root-relative POSIX (may start with ".."). */
  assets?: { from: string; to: string }[];
  /** Where links that leave the docs point. */
  links?: { repo?: string; branch?: string };
}

export interface AssembleInput {
  config: SiteConfig;
  /** Read a content file by its config-relative path. */
  readPage: (path: string) => string | Promise<string>;
  registry: ComponentRegistry;
  /** Snippet name (the `<Snippet file>` value) to its raw source. */
  snippets?: Record<string, string>;
  trust?: "owner" | "contributor" | "preview";
  themes?: { light: string; dark: string };
  /** Reused across builds for incremental, dependency-aware rendering. */
  renderCache?: RenderCache;
  /** Fail the build when any page produces an error diagnostic. */
  failOnError?: boolean;
  /** Participates in every page's cache key so a library bump invalidates all. */
  libVersion?: string;
  /** Canonical base URL for absolute links in sitemap, RSS, and agent outputs.
   * Falls back to `config.site.url`. Without either, URLs stay root-relative. */
  baseUrl?: string;
  /**
   * The normalized API spec for hybrid `openapi:` frontmatter pages, plus the
   * config-relative source path it was ingested from (validates Mintlify-style
   * file tokens like `openapi: "openapi.json GET /pets"`).
   */
  apiReference?: ApiReferenceInput | null;
  /**
   * Authored agent skills read from the content repo (`.readsmith/skills/`,
   * `.mintlify/skills/` as migration fallback, or a root `skill.md`). Assembly
   * validates them against the agentskills.io constraints and synthesizes the
   * mechanical fallback when none survive.
   */
  skills?: AuthoredSkill[];
}

/** One file inside a skill, path relative to the skill's root. */
export interface SkillFile {
  path: string;
  content: string;
}

/** A validated agent skill, ready to serve at `/.well-known/skills/<name>/`. */
export interface Skill {
  name: string;
  description: string;
  /** `files[0]` is always SKILL.md; the rest sort by path. */
  files: SkillFile[];
}

/** An authored skill as read from the content repo, before validation. */
export interface AuthoredSkill {
  /** Directory name under the skills root, or null for a root-level `skill.md`
   * (whose name may fall back to the site instead of a directory). */
  dir: string | null;
  /** Diagnostic source, e.g. ".readsmith/skills/payments" or "skill.md". */
  source: string;
  /** Files relative to the skill root; must include "SKILL.md". */
  files: SkillFile[];
}

/** The API-reference wiring assembly consumes (the resolved config's shape). */
export interface ApiReferenceInput {
  /** The normalized spec; `tags`, `info`, and `servers` feed pages mode. */
  spec: OperationContext & {
    tags?: { name: string; description?: string }[];
    info?: { title: string; version: string; description?: string };
    servers?: { url: string }[];
  };
  /** Config-relative source path (validates frontmatter file tokens). */
  source: string;
  /**
   * The URL the reference is mounted at. In single mode (the continuous page,
   * served outside this build) links to it validate against the operation ids
   * instead of being reported broken; in pages mode it is where the synthesized
   * pages and the overview live.
   */
  path?: string;
  /** "single" (default) or "pages" (synthesize one page per operation). */
  layout?: "single" | "pages";
  /** The nav label of the reference tab in pages mode. */
  label?: string;
}

export interface Breadcrumb {
  label: string;
  url?: string;
}

export interface NavLink {
  slug: string;
  url: string;
  title: string;
}

/** Hybrid API-operation binding: which operation an `openapi:` page documents. */
export interface PageApi {
  /** The frontmatter reference as written (trimmed), for example "GET /pets". */
  ref: string;
  /**
   * The resolved operation id, or null when the reference matched nothing (the
   * serving layer renders a danger callout in place of the generated sections).
   */
  operationId: string | null;
  /** Uppercased method from the reference, for example "GET". */
  method: string;
  path: string;
  /** The operation's first tag: the page's breadcrumb/eyebrow. */
  tag?: string;
  /** The frontmatter `deprecated` override, or the operation's own flag. */
  deprecated: boolean;
}

export interface PageModel {
  path: string;
  slug: string;
  url: string;
  title: string;
  /** Short label for the nav, when the page title is too long for a sidebar. */
  sidebarTitle?: string;
  description?: string;
  frontmatter: Record<string, unknown>;
  /** Unlisted: served at its URL, absent from nav, sitemap, feeds, and the AI index. */
  hidden: boolean;
  /** Emits a robots noindex meta and drops the page from the sitemap. */
  noindex: boolean;
  /**
   * The escaped `application/ld+json` payload, ready to inject verbatim, or null
   * for a hidden page. Escaped here rather than at the injection site: the CSP
   * allows inline scripts, so the serializer is the only line of defense.
   */
  jsonLd: string | null;
  html: string;
  toc: TocNode[];
  rawMd: string;
  chunks: Chunk[];
  anchors: string[];
  islands: IslandManifest;
  breadcrumbs: Breadcrumb[];
  prev?: NavLink;
  next?: NavLink;
  /**
   * Pages-mode mirror: the URL of the authored page this page duplicates so the
   * reference tab can show it without a tab jump. Mirrors render like any page
   * but are excluded from the sitemap, feeds, and the AI index, and the serving
   * layer points rel=canonical at this URL.
   */
  canonicalOf?: string;
  /** What the page is; "api-operation" pages carry `api` and a console layout,
   * "api-schema" pages carry `apiSchema` and a generated fields section. */
  kind: "doc" | "api-operation" | "api-schema";
  /** Present when `kind` is "api-operation". */
  api?: PageApi;
  /** Present when `kind` is "api-schema". */
  apiSchema?: PageSchemaApi;
  diagnostics: Diagnostic[];
}

/** Data-model binding: which component schema an `openapi-schema:` page documents. */
export interface PageSchemaApi {
  /** The frontmatter reference as written (trimmed), for example "Pet". */
  ref: string;
  /** The resolved component-schema name, or null when nothing matched. */
  name: string | null;
}

export type FinalNavNode =
  | {
      type: "page";
      slug: string;
      url: string;
      title: string;
      /** HTTP method badge for hybrid API-operation pages, e.g. "GET". */
      method?: string;
    }
  | { type: "group"; label: string; children: FinalNavNode[] };

/** A finalized top-level tab: label, landing URL (first page), and its nav tree. */
export interface FinalNavTab {
  label: string;
  url: string;
  nav: FinalNavNode[];
}

export interface SiteBuild {
  pages: PageModel[];
  nav: FinalNavNode[];
  /** Finalized top-level tabs, when configured. Absent for single-nav sites. */
  tabs?: FinalNavTab[];
  sitemap: string;
  rss: string;
  llmsTxt: string;
  llmsFullTxt: string;
  /** Agent skills: authored ones that passed validation, or the mechanical
   * fallback. Never empty; `/skill.md` and the discovery index serve these. */
  skills: Skill[];
  searchChunks: Chunk[];
  diagnostics: Diagnostic[];
  /** Stable hash of the whole build; identical inputs yield an identical hash. */
  bundleHash: string;
  /** False when `failOnError` is set and any error diagnostic was produced. */
  ok: boolean;
  /** Page paths re-rendered this build (a cache miss); the rest were cache hits. */
  rebuilt: string[];
}

/**
 * Map a relative image target onto the URL its file is served at.
 *
 * A declared mount wins, because a mount may point inside the content root too.
 * Otherwise a path that stays inside the content root is copied verbatim into
 * `public/`, so its URL mirrors its path. A path that escapes the content root
 * with no mount is unresolvable: refusing to guess is what keeps undeclared
 * directories unpublished.
 */
export function makeResolveAsset(
  assets: { from: string; to: string }[],
): (target: string) => string | null {
  return (target) => {
    for (const mount of assets) {
      if (target === mount.from) return `/${mount.to}`;
      if (target.startsWith(`${mount.from}/`)) {
        return `/${mount.to}/${target.slice(mount.from.length + 1)}`;
      }
    }
    if (target.startsWith("..")) return null;
    return `/${target}`;
  };
}

/**
 * Map a `.md` link that matched no page onto its file on the forge.
 *
 * Only paths that escape the content root qualify. An unresolved link *inside*
 * the content root is a genuine broken link and must keep warning: it usually
 * means a typo or a deleted page, and silently pointing it at the repository
 * would bury that.
 */
export function makeResolveOutsidePage(
  links: { repo?: string; branch?: string } | undefined,
  contentRel: string,
): ((target: string) => string | null) | undefined {
  const repo = links?.repo?.replace(/\/+$/, "");
  if (!repo) return undefined;
  const branch = links?.branch ?? "main";
  return (target) => {
    if (!target.startsWith("..")) return null;
    const repoRelative = posix.normalize(posix.join(contentRel, target));
    if (repoRelative.startsWith("..")) return null; // escapes the repository too
    return `${repo}/blob/${branch}/${repoRelative}`;
  };
}

/** Run the full site build: per-page pipeline, then site-level assembly. */
export async function assembleSite(input: AssembleInput): Promise<SiteBuild> {
  const { config } = input;
  const trust = input.trust ?? "owner";
  const resolvePage = makeResolvePage(config.pages);
  const resolveAsset = makeResolveAsset(config.assets ?? []);
  const resolveOutsidePage = makeResolveOutsidePage(config.links, config.content?.root ?? ".");

  const built = await Promise.all(
    config.pages.map((page) =>
      buildPage(page, input, trust, resolvePage, resolveAsset, resolveOutsidePage),
    ),
  );

  const models = built.map((b) => b.model);
  const rebuilt = built.filter((b) => b.rebuilt).map((b) => b.model.path);

  // Hybrid `openapi:` pages bind to their operations before nav finalization and
  // the agent outputs, because binding sets titles, descriptions, and rawMd.
  const claims = applyApiBindings(models, input.apiReference ?? null);

  // Pages mode: synthesize a page per unclaimed operation plus the overview,
  // and get back the reference nav subtree for the tab (null in single mode).
  const refNav = await applyPagesMode(input, built, models, claims);

  // Cross-page link + anchor validation, now that every page's anchors are known.
  const anchorsBySlug = new Map(models.map((m) => [m.slug, new Set(m.anchors)]));
  // In single mode the continuous API reference is served outside this build;
  // links to it are valid, and its anchors are the operation ids. (In pages
  // mode the reference pages are real pages and validate like any other.)
  const apiRefPath = input.apiReference?.layout === "pages" ? undefined : input.apiReference?.path;
  if (apiRefPath) {
    anchorsBySlug.set(
      apiRefPath.replace(/^\//, ""),
      new Set(input.apiReference?.spec.operations.map((op) => op.id) ?? []),
    );
  }
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const links = built[i]?.links ?? [];
    if (model) validateLinks(model, links, anchorsBySlug);
  }

  // Nav finalization needs titles and hidden flags from the built pages.
  const bySlug = new Map(models.map((m) => [m.slug, m]));
  const nav = finalizeNav(config.nav, bySlug);
  let tabs: FinalNavTab[] | undefined;
  if (config.tabs && config.tabs.length > 0) {
    // Each page belongs to exactly one tab; compute prev/next/breadcrumbs within it.
    tabs = config.tabs.map((tab) => {
      const tabNav = finalizeNav(tab.nav, bySlug);
      applyNavRelations(tabNav, bySlug);
      return { label: tab.label, url: firstPageUrl(tabNav) ?? "/", nav: tabNav };
    });
    // Pages mode: the reference joins the tab row as its own tab. Explicitly
    // placed pages appear via their mirrors, which take relations here while
    // the authored originals keep their home tab's.
    if (refNav) {
      const tabNav = finalizeNav(refNav.nodes, bySlug);
      applyNavRelations(tabNav, bySlug);
      tabs.push({ label: refNav.label, url: refNav.url, nav: tabNav });
    }
  } else {
    // A tabless site gets the reference nav appended to the main sidebar.
    if (refNav) nav.push(...finalizeNav(refNav.nodes, bySlug));
    applyNavRelations(nav, bySlug);
  }

  // Mirrors serve and sit in the nav, but every listing surface shows a page
  // once: the authored original speaks for both copies.
  const visible = models.filter((m) => !m.hidden && !m.canonicalOf);
  // The sitemap is the one output that invites a crawler, so it honors `noindex`
  // in addition to `hidden`. The feeds and the AI index track `hidden` alone.
  const indexable = visible.filter((m) => !m.noindex);
  const base = (input.baseUrl ?? config.site.url ?? "").replace(/\/+$/, "");

  // Structured data needs the canonical base, which is only known here. Hidden
  // pages emit none: they are unlisted everywhere else, and a search engine has
  // no business being handed a description of one.
  const jsonLdSite = {
    name: config.site.name,
    url: config.site.url,
    author: config.site.author,
    publisher: config.site.publisher,
  };
  for (const model of models) {
    // A mirror emits none: its rel=canonical already names the page that does.
    model.jsonLd = model.canonicalOf ? null : buildJsonLd(jsonLdSite, model, base);
  }

  const sitemap = buildSitemap(indexable, base);
  const rss = buildRss(config, visible, base);
  const llmsTxt = buildLlmsTxt(config, visible, base);
  const llmsFullTxt = buildLlmsFullTxt(config, visible, base);
  const skillsResult = assembleSkills(input.skills ?? [], config, visible, base);
  const searchChunks = visible.flatMap((m) => m.chunks);

  const diagnostics = [...models.flatMap((m) => m.diagnostics), ...skillsResult.diagnostics];
  const ok = !(input.failOnError && diagnostics.some((d) => d.severity === "error"));

  const bundleHash = contentHash({
    site: config.site.name,
    pages: [...models]
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map((m) => ({
        slug: m.slug,
        title: m.title,
        html: m.html,
        hidden: m.hidden,
        noindex: m.noindex,
        jsonLd: m.jsonLd,
      })),
    nav,
    tabs: tabs ?? null,
    sitemap,
    rss,
    llmsTxt,
    llmsFullTxt,
    skills: skillsResult.skills,
  });

  return {
    pages: models,
    nav,
    tabs,
    sitemap,
    rss,
    llmsTxt,
    llmsFullTxt,
    skills: skillsResult.skills,
    searchChunks,
    diagnostics,
    bundleHash,
    ok,
    rebuilt,
  };
}

interface InternalLink {
  url: string;
  pos?: { line: number; col: number };
}

interface BuiltPage {
  model: PageModel;
  links: InternalLink[];
  rebuilt: boolean;
}

async function buildPage(
  page: SitePage,
  input: AssembleInput,
  trust: "owner" | "contributor" | "preview",
  resolvePage: (targetPathNoExt: string) => string | null,
  resolveAsset: (target: string) => string | null,
  resolveOutsidePage: ((target: string) => string | null) | undefined,
): Promise<BuiltPage> {
  const { config } = input;
  const globals = config.variables ?? {};

  let raw: string;
  try {
    raw = await input.readPage(page.path);
  } catch (err) {
    return errorPage(page, `Could not read page: ${(err as Error).message}`);
  }

  const parsed = parse({ path: page.path, raw });
  const frontmatter = parsed.frontmatter;

  const usedSnippets = new Map<string, string>();
  const expanded = expandSnippetsAndVariables(parsed.body, {
    path: page.path,
    global: globals,
    page: frontmatter,
    resolveSnippet: makeSnippetResolver(input.snippets ?? {}, usedSnippets),
  });

  const transformed = transform(expanded.body, {
    path: page.path,
    contentRel: config.content?.root ?? ".",
    resolvePage,
    resolveAsset,
    resolveOutsidePage,
  });
  const projections = project(transformed.body, {
    path: page.path,
    url: slugToUrl(page.slug),
  });
  const anchors = collectAnchors(transformed.body);
  const links = collectLinks(transformed.body);

  const hidden = frontmatter.hidden === true;
  // A page deliberately dropped from the nav, the sitemap, the feeds, and the AI
  // index almost certainly should not be in Google either. Explicit wins.
  const noindex = frontmatter.noindex === true || (hidden && frontmatter.noindex !== false);
  const title = pickTitle(frontmatter, transformed.body, page.slug, config.site.name);
  const sidebarTitle =
    typeof frontmatter.sidebarTitle === "string" && frontmatter.sidebarTitle.trim()
      ? frontmatter.sidebarTitle
      : undefined;
  const description =
    typeof frontmatter.description === "string" ? frontmatter.description : undefined;

  const cacheKey = contentHash({
    lib: input.libVersion ?? "0",
    trust,
    theme: config.site.theme ?? {},
    path: page.path,
    source: raw,
    globals,
    frontmatter,
    snippets: [...usedSnippets].sort(([a], [b]) => a.localeCompare(b)),
  });

  let renderResult: RenderResult;
  let rebuilt = false;
  const cached = input.renderCache?.get(cacheKey);
  if (cached) {
    renderResult = cached;
  } else {
    renderResult = await render(transformed.body, {
      path: page.path,
      trust,
      scope: { ...globals, ...frontmatter },
      registry: input.registry,
      themes: input.themes,
    });
    input.renderCache?.set(cacheKey, renderResult);
    rebuilt = true;
  }

  const model: PageModel = {
    path: page.path,
    slug: page.slug,
    url: slugToUrl(page.slug),
    title,
    sidebarTitle,
    description,
    frontmatter,
    hidden,
    noindex,
    jsonLd: null, // assigned in assembleSite, which knows the canonical base
    html: renderResult.html,
    toc: projections.toc,
    rawMd: projections.rawMd,
    chunks: projections.chunks,
    anchors,
    islands: renderResult.hydration,
    breadcrumbs: [],
    kind: "doc",
    diagnostics: [
      ...parsed.diagnostics,
      ...expanded.diagnostics,
      ...transformed.diagnostics,
      ...renderResult.diagnostics,
    ],
  };

  return { model, links, rebuilt };
}

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

interface OpenapiRef {
  file?: string;
  method: string;
  path: string;
}

/**
 * Parse an `openapi:` frontmatter value: `METHOD /path`, optionally preceded by
 * a spec-file token (the Mintlify multi-spec form): `openapi.json GET /pets`.
 */
function parseOpenapiRef(value: string): OpenapiRef | null {
  const parts = value.trim().split(/\s+/);
  const [file, method, path] =
    parts.length === 2 ? [undefined, parts[0], parts[1]] : parts.length === 3 ? parts : [];
  if (!method || !path) return null;
  if (!HTTP_METHODS.has(method.toLowerCase()) || !path.startsWith("/")) return null;
  return file !== undefined ? { file, method, path } : { method, path };
}

/** Compare spec-file tokens leniently: a leading "./" is not a different file. */
function fileToken(p: string): string {
  return p.replace(/^\.\//, "");
}

/** The first sentence of a description, for metadata fallbacks. */
function firstSentence(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const match = line.match(/^.*?[.!?](?=\s|$)/);
  const sentence = match ? (match[0] ?? line) : line;
  return sentence.length > 200 ? `${sentence.slice(0, 200).trimEnd()}...` : sentence;
}

/**
 * Resolve one model's binding to its operation: id, tag, deprecated carry,
 * title and description fallbacks (frontmatter always wins), and the markdown
 * projection appended to rawMd plus a synthetic search chunk. Shared by
 * authored hybrid pages and pages-mode synthesis.
 */
function applyOperationBinding(
  model: PageModel,
  op: Operation,
  spec: ApiReferenceInput["spec"],
): void {
  if (!model.api) return;
  model.api.operationId = op.id;
  if (op.tags[0] !== undefined) model.api.tag = op.tags[0];
  model.api.deprecated = model.api.deprecated || op.deprecated;

  if (typeof model.frontmatter.title !== "string" || !model.frontmatter.title.trim()) {
    model.title = op.summary?.trim() || `${model.api.method} ${op.path}`;
  }
  if (model.description === undefined && op.description) {
    model.description = firstSentence(op.description);
  }

  // The agent projection rides the raw markdown and the search chunks: the
  // .md route, llms.txt, and Ask-AI citations see the full contract.
  const projection = operationToMarkdown(op, spec);
  model.rawMd = model.rawMd.trim() ? `${model.rawMd.trim()}\n\n${projection}` : projection;
  model.chunks = [
    ...model.chunks,
    {
      id: contentHash({ path: model.path, api: op.id }),
      page_id: model.path,
      path: model.url,
      header_path: [model.title],
      anchor: "",
      text: projection,
    },
  ];
}

/**
 * Bind hybrid `openapi:` pages to their operations (spec section HA-1..5, 22..25).
 * Runs after every page is built and before nav finalization: binding sets the
 * page kind, title and description fallbacks, and appends the operation's
 * markdown projection to rawMd and the search chunks, so agent surfaces carry
 * the full contract per operation. One operation, one page: the first claim in
 * discovery order wins; later claims are diagnosed and left unresolved (the
 * serving layer shows a danger callout for an unresolved binding). Returns the
 * claims (operation id to the page that documents it) for pages-mode synthesis.
 */
function applyApiBindings(
  models: PageModel[],
  apiReference: ApiReferenceInput | null,
): Map<string, PageModel> {
  const claimed = new Map<string, PageModel>();
  const claimedSchemas = new Map<string, PageModel>();
  for (const model of models) {
    const fail = (severity: Diagnostic["severity"], code: string, message: string): void => {
      model.diagnostics.push({ severity, code, message, source: model.path });
    };

    // Data-model pages: `openapi-schema: "Pet"` (optionally with the Mintlify
    // file token). When a page carries BOTH keys, the operation wins and the
    // schema key is diagnosed: one page, one generated subject.
    const rawSchema = model.frontmatter["openapi-schema"];
    if (rawSchema !== undefined && model.frontmatter.openapi !== undefined) {
      fail(
        "warning",
        "openapi-schema-conflict",
        "This page has both `openapi` and `openapi-schema`; the operation wins and the schema key is ignored.",
      );
    } else if (rawSchema !== undefined) {
      bindSchemaPage(model, rawSchema, apiReference, claimedSchemas, fail);
      continue;
    }

    const raw = model.frontmatter.openapi;
    if (raw === undefined) continue;

    if (typeof raw !== "string" || !raw.trim()) {
      fail(
        "error",
        "invalid-openapi-ref",
        'The `openapi` frontmatter must be a string like "GET /pets".',
      );
      continue;
    }
    const ref = parseOpenapiRef(raw);
    if (!ref) {
      fail(
        "error",
        "invalid-openapi-ref",
        `Could not parse openapi reference "${raw.trim()}" (expected "METHOD /path" or "spec-file METHOD /path").`,
      );
      continue;
    }

    model.kind = "api-operation";
    model.api = {
      ref: raw.trim(),
      operationId: null,
      method: ref.method.toUpperCase(),
      path: ref.path,
      deprecated: model.frontmatter.deprecated === true,
    };

    // Mintlify pages may carry a `version` key; versioning is a later milestone.
    if (model.frontmatter.version !== undefined) {
      fail(
        "info",
        "openapi-version-ignored",
        "Frontmatter `version` is not supported yet; ignored.",
      );
    }

    if (!apiReference) {
      fail(
        "error",
        "openapi-not-configured",
        "This page references an OpenAPI operation, but no `apiReference` spec is configured.",
      );
      continue;
    }
    if (ref.file !== undefined && fileToken(ref.file) !== fileToken(apiReference.source)) {
      fail(
        "warning",
        "openapi-file-mismatch",
        `The spec file "${ref.file}" does not match the configured "${apiReference.source}"; token ignored (one spec per site for now).`,
      );
    }

    const op = findOperation(apiReference.spec, ref.method, ref.path);
    if (!op) {
      fail(
        "error",
        "unknown-operation",
        `No operation matches "${model.api.method} ${ref.path}" in the configured spec.`,
      );
      continue;
    }
    const prior = claimed.get(op.id);
    if (prior !== undefined) {
      fail(
        "error",
        "duplicate-operation-page",
        `Operation "${op.id}" is already documented by "${prior.path}"; one operation, one page.`,
      );
      continue;
    }
    claimed.set(op.id, model);
    applyOperationBinding(model, op, apiReference.spec);
  }
  return claimed;
}

/**
 * Bind an `openapi-schema:` page to its component schema (HA-15): kind, title
 * and description fallbacks from the schema, and the field projection appended
 * to rawMd plus a synthetic search chunk. One schema, one page.
 */
function bindSchemaPage(
  model: PageModel,
  raw: unknown,
  apiReference: ApiReferenceInput | null,
  claimedSchemas: Map<string, PageModel>,
  fail: (severity: Diagnostic["severity"], code: string, message: string) => void,
): void {
  if (typeof raw !== "string" || !raw.trim()) {
    fail(
      "error",
      "invalid-openapi-schema-ref",
      'The `openapi-schema` frontmatter must be a string like "Pet".',
    );
    return;
  }
  const parts = raw.trim().split(/\s+/);
  const [file, name] = parts.length === 2 ? parts : parts.length === 1 ? [undefined, parts[0]] : [];
  if (!name) {
    fail(
      "error",
      "invalid-openapi-schema-ref",
      `Could not parse openapi-schema reference "${raw.trim()}" (expected "SchemaName" or "spec-file SchemaName").`,
    );
    return;
  }

  model.kind = "api-schema";
  model.apiSchema = { ref: raw.trim(), name: null };

  if (!apiReference) {
    fail(
      "error",
      "openapi-not-configured",
      "This page references an OpenAPI schema, but no `apiReference` spec is configured.",
    );
    return;
  }
  if (file !== undefined && fileToken(file) !== fileToken(apiReference.source)) {
    fail(
      "warning",
      "openapi-file-mismatch",
      `The spec file "${file}" does not match the configured "${apiReference.source}"; token ignored (one spec per site for now).`,
    );
  }
  const schema = apiReference.spec.schemas[name];
  if (!schema) {
    fail(
      "error",
      "unknown-schema",
      `No component schema named "${name}" exists in the configured spec.`,
    );
    return;
  }
  const prior = claimedSchemas.get(name);
  if (prior !== undefined) {
    fail(
      "error",
      "duplicate-schema-page",
      `Schema "${name}" is already documented by "${prior.path}"; one schema, one page.`,
    );
    return;
  }
  claimedSchemas.set(name, model);
  model.apiSchema.name = name;

  if (typeof model.frontmatter.title !== "string" || !model.frontmatter.title.trim()) {
    model.title = schema.title?.trim() || name;
  }
  if (model.description === undefined && schema.description) {
    model.description = firstSentence(schema.description);
  }

  const projection = schemaToMarkdown(name, apiReference.spec);
  model.rawMd = model.rawMd.trim() ? `${model.rawMd.trim()}\n\n${projection}` : projection;
  model.chunks = [
    ...model.chunks,
    {
      id: contentHash({ path: model.path, apiSchema: name }),
      page_id: model.path,
      path: model.url,
      header_path: [model.title],
      anchor: "",
      text: projection,
    },
  ];
}

interface RefNav {
  label: string;
  url: string;
  nodes: NavNode[];
}

/**
 * Every page slug placed explicitly in the navigation that is actually
 * rendered: the tabs when configured, else the flat nav. With tabs present the
 * flat nav is an unused fallback (often the auto-discovered FULL tree), and
 * counting it would mark every page as "explicitly placed".
 */
function collectNavSlugs(config: SiteConfig): Set<string> {
  const slugs = new Set<string>();
  const walk = (nodes: NavNode[]): void => {
    for (const node of nodes) {
      if (node.type === "page") slugs.add(node.slug);
      else walk(node.children);
    }
  };
  if (config.tabs && config.tabs.length > 0) {
    for (const tab of config.tabs) walk(tab.nav);
  } else {
    walk(config.nav);
  }
  return slugs;
}

/** Operations grouped by first tag; tag order from the spec, then alphabetical. */
function groupOperations(
  spec: ApiReferenceInput["spec"],
): { tag: string; operations: Operation[] }[] {
  const order = (spec.tags ?? []).map((t) => t.name);
  const byTag = new Map<string, Operation[]>();
  for (const op of spec.operations) {
    const tag = op.tags[0] ?? "General";
    const list = byTag.get(tag);
    if (list) list.push(op);
    else byTag.set(tag, [op]);
  }
  const tags = [...byTag.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
  return tags.map((tag) => ({ tag, operations: byTag.get(tag) ?? [] }));
}

/** The generated overview page: title, description, meta, tag-grouped index. */
function buildOverviewMarkdown(
  spec: ApiReferenceInput["spec"],
  urlByOp: Map<string, string>,
): string {
  const info = spec.info;
  const lines = [`# ${info?.title ?? "API Reference"}`, ""];
  if (info?.description) lines.push(info.description, "");
  const meta: string[] = [];
  const server = spec.servers?.[0]?.url;
  if (server) meta.push(`- Base URL: \`${server}\``);
  if (info?.version) meta.push(`- Version: ${info.version}`);
  if (meta.length > 0) lines.push(...meta, "");
  for (const group of groupOperations(spec)) {
    lines.push(`## ${group.tag}`, "");
    const description = spec.tags?.find((t) => t.name === group.tag)?.description;
    if (description) lines.push(description, "");
    for (const op of group.operations) {
      const url = urlByOp.get(op.id);
      if (!url) continue;
      lines.push(`- [\`${op.method.toUpperCase()}\` ${op.summary ?? op.path}](${url})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Pages mode (spec HA-11/12/13): synthesize one page per operation that no
 * authored page claims (deterministic github-slugger slugs from the operation
 * id, collisions diagnosed), plus a pipeline-rendered overview at the
 * reference root (skipped when an authored page owns that slug). Returns the
 * reference nav subtree. A page the author placed explicitly in the configured
 * navigation keeps that home, and (with tabs) is MIRRORED at its reference
 * slug: the catalog row must open inside the reference tab, not jump the
 * reader to another tab's context.
 */
async function applyPagesMode(
  input: AssembleInput,
  built: BuiltPage[],
  models: PageModel[],
  claims: Map<string, PageModel>,
): Promise<RefNav | null> {
  const ref = input.apiReference;
  if (!ref || ref.layout !== "pages") return null;
  const spec = ref.spec;
  const refPath = (ref.path ?? "/api-reference").replace(/\/+$/, "");
  const refSlug = refPath.replace(/^\//, "");
  const label = ref.label ?? "API Reference";
  const hasTabs = (input.config.tabs?.length ?? 0) > 0;
  const explicit = collectNavSlugs(input.config);

  const slugger = new GithubSlugger();
  const seenBases = new Set<string>();
  const urlByOp = new Map<string, string>();

  for (const op of spec.operations) {
    const claimedModel = claims.get(op.id);
    // A claimed page without an explicit placement (or on a tabless site) is
    // simply homed in the reference tree at its own URL; no mirror needed.
    if (claimedModel && !(hasTabs && explicit.has(claimedModel.slug))) {
      urlByOp.set(op.id, claimedModel.url);
      continue;
    }
    const base = new GithubSlugger().slug(op.id);
    const opSlug = slugger.slug(op.id); // deduplicates deterministically
    const slug = `${refSlug}/${opSlug}`;
    if (claimedModel) {
      // The mirror: the same rendered page, re-homed under the reference slug
      // so the reference tab's relations and active-tab context apply. It is
      // excluded from the sitemap, feeds, and the AI index (canonicalOf), and
      // carries no chunks so nothing is indexed twice.
      const mirror: PageModel = {
        ...claimedModel,
        path: `${slug}.generated`,
        slug,
        url: `/${slug}`,
        canonicalOf: claimedModel.url,
        chunks: [],
        breadcrumbs: [],
        prev: undefined,
        next: undefined,
        diagnostics: [],
      };
      if (seenBases.has(base)) {
        mirror.diagnostics.push({
          severity: "error",
          code: "operation-slug-collision",
          message: `Operation slug "${base}" collides with another operation; serving this one at "${opSlug}".`,
          source: mirror.path,
        });
      }
      seenBases.add(base);
      models.push(mirror);
      built.push({ model: mirror, links: [], rebuilt: true });
      urlByOp.set(op.id, mirror.url);
      continue;
    }
    const model: PageModel = {
      path: `${slug}.generated`,
      slug,
      url: `/${slug}`,
      title: "",
      frontmatter: {},
      hidden: false,
      noindex: false,
      jsonLd: null,
      html: "",
      toc: [],
      rawMd: "",
      chunks: [],
      anchors: [],
      islands: { islands: [] },
      breadcrumbs: [],
      kind: "api-operation",
      api: {
        ref: `${op.method.toUpperCase()} ${op.path}`,
        operationId: null,
        method: op.method.toUpperCase(),
        path: op.path,
        deprecated: false,
      },
      diagnostics: [],
    };
    if (seenBases.has(base)) {
      model.diagnostics.push({
        severity: "error",
        code: "operation-slug-collision",
        message: `Operation slug "${base}" collides with another operation; serving this one at "${opSlug}".`,
        source: model.path,
      });
    }
    seenBases.add(base);
    applyOperationBinding(model, op, spec);
    models.push(model);
    built.push({ model, links: [], rebuilt: true });
    urlByOp.set(op.id, model.url);
  }

  // The overview at the reference root, unless an authored page owns the slug
  // (an author replacing the generated front door is a feature, not a clash).
  const rootTaken = models.some((m) => m.slug === refSlug);
  if (!rootTaken) {
    const virtualPath = `${refSlug}/_overview.md`;
    const overviewMd = buildOverviewMarkdown(spec, urlByOp);
    const overviewInput: AssembleInput = {
      ...input,
      readPage: (p) => (p === virtualPath ? overviewMd : input.readPage(p)),
    };
    const overview = await buildPage(
      { path: virtualPath, slug: refSlug },
      overviewInput,
      input.trust ?? "owner",
      () => null,
      () => null,
      undefined,
    );
    models.push(overview.model);
    built.push(overview);
  }

  // The nav subtree: overview first, then tag groups with EVERY operation (the
  // reference is a catalog; a missing row reads as an undocumented endpoint).
  // Explicitly placed pages appear here through their mirrors (built above), so
  // every row stays inside the reference tab. On a tabless site the explicit
  // row is excluded instead: it would duplicate inside one sidebar column.
  const nodes: NavNode[] = [];
  if (models.some((m) => m.slug === refSlug) && !explicit.has(refSlug)) {
    nodes.push({ type: "page", slug: refSlug });
  }
  for (const group of groupOperations(spec)) {
    const children: NavNode[] = [];
    for (const op of group.operations) {
      const slug = urlByOp.get(op.id)?.replace(/^\//, "");
      if (!slug) continue;
      if (!hasTabs && explicit.has(slug)) continue;
      children.push({ type: "page", slug });
    }
    if (children.length > 0) nodes.push({ type: "group", label: group.tag, children });
  }
  return { label, url: refPath, nodes };
}

function errorPage(page: SitePage, message: string): BuiltPage {
  return {
    model: {
      path: page.path,
      slug: page.slug,
      url: slugToUrl(page.slug),
      title: page.slug || "Untitled",
      frontmatter: {},
      hidden: false,
      noindex: false,
      jsonLd: null,
      html: "",
      toc: [],
      rawMd: "",
      chunks: [],
      anchors: [],
      islands: { islands: [] },
      breadcrumbs: [],
      kind: "doc",
      diagnostics: [{ severity: "error", code: "page-build-error", message, source: page.path }],
    },
    links: [],
    rebuilt: true,
  };
}

/** Resolve a content-relative path (without extension) to a slug, or null. */
function makeResolvePage(pages: SitePage[]): (targetPathNoExt: string) => string | null {
  const map = new Map<string, string>();
  for (const p of pages) {
    map.set(p.path.replace(/\.(md|mdx)$/i, ""), p.slug);
  }
  return (target) => map.get(target) ?? null;
}

/** A snippet resolver over an in-memory source map that records dependency hashes. */
function makeSnippetResolver(
  snippets: Record<string, string>,
  used: Map<string, string>,
): (name: string) => Root | null {
  return (name) => {
    const source = snippets[name];
    if (source === undefined) return null;
    used.set(name, contentHash(source));
    const kind = name.toLowerCase().endsWith(".mdx") ? "mdx" : "md";
    return parse({ path: name, raw: source, kind }).body;
  };
}

function collectAnchors(body: Root): string[] {
  const anchors: string[] = [];
  visit(body, "heading", (node) => {
    const id = (node.data as { id?: unknown } | undefined)?.id;
    if (typeof id === "string" && id) anchors.push(id);
  });
  return anchors;
}

function collectLinks(body: Root): InternalLink[] {
  const links: InternalLink[] = [];
  visit(body, "link", (node) => {
    const start = node.position?.start;
    links.push({
      url: node.url,
      pos: start ? { line: start.line, col: start.column } : undefined,
    });
  });
  return links;
}

/**
 * Validate a page's internal links against the full slug and anchor set. A link
 * to a missing page or a missing anchor is reported; external and resolved
 * links are left alone. Relative-link resolution already happened in P2.
 */
function validateLinks(
  model: PageModel,
  links: InternalLink[],
  anchorsBySlug: Map<string, Set<string>>,
): void {
  for (const link of links) {
    const url = link.url;
    let targetSlug: string | null = null;
    let anchor = "";

    if (url.startsWith("#")) {
      targetSlug = model.slug;
      anchor = url.slice(1);
    } else if (url.startsWith("/")) {
      const hash = url.indexOf("#");
      const pathPart = hash === -1 ? url : url.slice(0, hash);
      anchor = hash === -1 ? "" : url.slice(hash + 1);
      targetSlug = pathPart === "/" ? "" : pathPart.slice(1);
    } else {
      continue; // external, mailto, or already-diagnosed relative link
    }

    const targetAnchors = anchorsBySlug.get(targetSlug);
    if (!targetAnchors) {
      model.diagnostics.push({
        severity: "warning",
        code: "broken-link",
        message: `Link "${url}" points to a page that does not exist.`,
        pos: link.pos,
        source: model.path,
      });
      continue;
    }
    if (anchor && !targetAnchors.has(anchor)) {
      model.diagnostics.push({
        severity: "warning",
        code: "broken-anchor",
        message: `Link "${url}" points to an anchor that does not exist.`,
        pos: link.pos,
        source: model.path,
      });
    }
  }
}

/** The label a page carries in navigation chrome: sidebar, breadcrumbs, prev/next. */
function navTitle(model: PageModel): string {
  return model.sidebarTitle ?? model.title;
}

/** Attach titles and drop hidden pages and empty groups from the nav tree. */
function finalizeNav(nav: NavNode[], bySlug: Map<string, PageModel>): FinalNavNode[] {
  const out: FinalNavNode[] = [];
  for (const node of nav) {
    if (node.type === "page") {
      const model = bySlug.get(node.slug);
      if (!model || model.hidden) continue;
      const method = model.kind === "api-operation" ? model.api?.method : undefined;
      out.push({
        type: "page",
        slug: model.slug,
        url: model.url,
        title: navTitle(model),
        ...(method !== undefined ? { method } : {}),
      });
    } else {
      const children = finalizeNav(node.children, bySlug);
      if (children.length > 0) out.push({ type: "group", label: node.label, children });
    }
  }
  return out;
}

/** The URL of the first page in a finalized nav tree (a tab's landing target). */
function firstPageUrl(nav: FinalNavNode[]): string | undefined {
  for (const node of nav) {
    if (node.type === "page") return node.url;
    const nested = firstPageUrl(node.children);
    if (nested) return nested;
  }
  return undefined;
}

/** Compute prev/next and breadcrumbs from the finalized nav order. */
function applyNavRelations(nav: FinalNavNode[], bySlug: Map<string, PageModel>): void {
  const order: { slug: string; trail: Breadcrumb[] }[] = [];
  const walk = (nodes: FinalNavNode[], trail: Breadcrumb[]): void => {
    for (const node of nodes) {
      if (node.type === "page") {
        order.push({
          slug: node.slug,
          trail: [...trail, { label: node.title, url: node.url }],
        });
      } else {
        walk(node.children, [...trail, { label: node.label }]);
      }
    }
  };
  walk(nav, []);

  for (let i = 0; i < order.length; i++) {
    const entry = order[i];
    if (!entry) continue;
    const model = bySlug.get(entry.slug);
    if (!model) continue;
    model.breadcrumbs = entry.trail;
    const prev = order[i - 1];
    const next = order[i + 1];
    if (prev) model.prev = navLink(bySlug.get(prev.slug));
    if (next) model.next = navLink(bySlug.get(next.slug));
  }
}

function navLink(model: PageModel | undefined): NavLink | undefined {
  if (!model) return undefined;
  return { slug: model.slug, url: model.url, title: navTitle(model) };
}

/** Prepend the canonical base to a root-relative URL, when a base is configured. */
function absUrl(base: string, url: string): string {
  return base ? base + url : url;
}

function buildSitemap(pages: PageModel[], base: string): string {
  const urls = [...pages]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((p) => {
      const date = typeof p.frontmatter.date === "string" ? p.frontmatter.date : undefined;
      const lastmod = date ? `<lastmod>${xml(date)}</lastmod>` : "";
      return `  <url><loc>${xml(absUrl(base, p.url))}</loc>${lastmod}</url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** RSS from pages that carry a frontmatter `date` (the changelog convention), newest first. */
function buildRss(config: SiteConfig, pages: PageModel[], base: string): string {
  const dated = pages
    .filter((p) => typeof p.frontmatter.date === "string")
    .sort((a, b) => String(b.frontmatter.date).localeCompare(String(a.frontmatter.date)));
  const items = dated
    .map((p) => {
      const link = absUrl(base, p.url);
      const desc = p.description ? `<description>${xml(p.description)}</description>` : "";
      const date = `<pubDate>${xml(String(p.frontmatter.date))}</pubDate>`;
      const guid = `<guid isPermaLink="true">${xml(link)}</guid>`;
      return `    <item><title>${xml(p.title)}</title><link>${xml(link)}</link>${guid}${date}${desc}</item>`;
    })
    .join("\n");
  const channelLink = base || "/";
  const desc = config.site.description ? xml(config.site.description) : xml(config.site.name);
  const self = base
    ? `\n    <atom:link href="${xml(`${base}/rss.xml`)}" rel="self" type="application/rss+xml"/>`
    : "";
  const head = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>`;
  const channel = `    <title>${xml(config.site.name)}</title>\n    <link>${xml(channelLink)}</link>\n    <description>${desc}</description>${self}`;
  return `${head}\n${channel}\n${items}${items ? "\n" : ""}  </channel></rss>\n`;
}

function buildLlmsTxt(config: SiteConfig, pages: PageModel[], base: string): string {
  const lines = [`# ${config.site.name}`, ""];
  if (config.site.description) lines.push(`> ${config.site.description}`, "");
  lines.push("## Pages", "");
  for (const p of pages) {
    lines.push(
      `- [${p.title}](${absUrl(base, p.url)})${p.description ? `: ${p.description}` : ""}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function buildLlmsFullTxt(config: SiteConfig, pages: PageModel[], base: string): string {
  const parts = [`# ${config.site.name}`, ""];
  for (const p of pages) {
    parts.push(`# ${p.title}`, `URL: ${absUrl(base, p.url)}`, "", p.rawMd.trim(), "");
  }
  return `${parts.join("\n")}\n`;
}

/** agentskills.io name rule: 1-64 lowercase alphanumerics and single hyphens. */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_NAME_MAX = 64;
const SKILL_DESCRIPTION_MAX = 1024;
const SKILL_COMPATIBILITY_MAX = 500;
/** Per-file cap: keeps a stray binary or fixture dump out of the bundle. */
const SKILL_FILE_MAX_BYTES = 262144;

/** Squeeze an arbitrary display name into a spec-valid skill name. Exported
 * for the skill generator, whose write target must match the fallback's name. */
export function skillNameOf(display: string): string {
  const squeezed = display
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_NAME_MAX)
    .replace(/-+$/, "");
  return squeezed || "docs";
}

/** Frontmatter of a SKILL.md, or null when the file has no parseable block. */
function skillFrontmatter(content: string): Record<string, unknown> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match || typeof match[1] !== "string") return null;
  try {
    const parsed: unknown = parseYaml(match[1]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Validate authored skills against the agentskills.io constraints and fall back
 * to the mechanical skill when none survive (SK-1..SK-3). A violation drops the
 * skill with an error diagnostic; the build itself continues. Deterministic:
 * authored input is processed in source order after sorting, and the result is
 * sorted by name.
 */
function assembleSkills(
  authored: AuthoredSkill[],
  config: SiteConfig,
  pages: PageModel[],
  base: string,
): { skills: Skill[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const skills: Skill[] = [];
  const seen = new Set<string>();
  const sorted = [...authored].sort((a, b) => a.source.localeCompare(b.source));

  if (sorted.some((s) => s.source.startsWith(".mintlify/"))) {
    diagnostics.push({
      severity: "info",
      code: "skills-mintlify-dir",
      message:
        'Skills were read from ".mintlify/skills/" (migration fallback). Move them to ".readsmith/skills/" when convenient.',
      source: ".mintlify/skills",
    });
  }

  for (const entry of sorted) {
    const err = (code: string, message: string): void => {
      diagnostics.push({ severity: "error", code, message, source: entry.source });
    };
    const skillFile = entry.files.find((f) => f.path === "SKILL.md");
    if (!skillFile) {
      err("skill-frontmatter", "Skill has no SKILL.md file.");
      continue;
    }
    if (skillFile.content.length > SKILL_FILE_MAX_BYTES) {
      err("skill-file-too-large", `SKILL.md exceeds ${SKILL_FILE_MAX_BYTES} bytes.`);
      continue;
    }
    const fm = skillFrontmatter(skillFile.content);
    // The root-level skill.md may lean on the site for identity (Mintlify
    // parity); a directory skill must carry its own frontmatter.
    const isRoot = entry.dir === null;
    if (!fm && !isRoot) {
      err("skill-frontmatter", "SKILL.md must start with YAML frontmatter (name, description).");
      continue;
    }
    const rawName = fm?.name;
    const rawDescription = fm?.description;
    let name: string;
    if (typeof rawName === "string" && rawName.length > 0) {
      if (rawName.length > SKILL_NAME_MAX || !SKILL_NAME_RE.test(rawName)) {
        err(
          "skill-invalid-name",
          `Skill name "${rawName}" must be 1-${SKILL_NAME_MAX} chars of lowercase letters, digits, and single hyphens.`,
        );
        continue;
      }
      if (!isRoot && rawName !== entry.dir) {
        err(
          "skill-invalid-name",
          `Skill name "${rawName}" must match its directory name "${entry.dir}".`,
        );
        continue;
      }
      name = rawName;
    } else if (isRoot) {
      name = skillNameOf(config.site.name);
    } else {
      err("skill-frontmatter", "Skill frontmatter is missing the required `name`.");
      continue;
    }
    let description: string;
    if (typeof rawDescription === "string" && rawDescription.length > 0) {
      if (rawDescription.length > SKILL_DESCRIPTION_MAX) {
        err(
          "skill-invalid-description",
          `Skill description exceeds ${SKILL_DESCRIPTION_MAX} characters.`,
        );
        continue;
      }
      description = rawDescription;
    } else if (isRoot) {
      description = config.site.description ?? `Documentation for ${config.site.name}.`;
    } else {
      err("skill-frontmatter", "Skill frontmatter is missing the required `description`.");
      continue;
    }
    const compatibility = fm?.compatibility;
    if (typeof compatibility === "string" && compatibility.length > SKILL_COMPATIBILITY_MAX) {
      err(
        "skill-frontmatter",
        `Skill \`compatibility\` exceeds ${SKILL_COMPATIBILITY_MAX} characters.`,
      );
      continue;
    }
    if (seen.has(name)) {
      err("duplicate-skill", `A skill named "${name}" already exists; this one is dropped.`);
      continue;
    }
    const extras = entry.files
      .filter((f) => f.path !== "SKILL.md")
      .filter((f) => {
        if (f.content.length <= SKILL_FILE_MAX_BYTES) return true;
        diagnostics.push({
          severity: "warning",
          code: "skill-file-too-large",
          message: `Skill file "${f.path}" exceeds ${SKILL_FILE_MAX_BYTES} bytes and is not served.`,
          source: entry.source,
        });
        return false;
      })
      .sort((a, b) => a.path.localeCompare(b.path));
    seen.add(name);
    skills.push({ name, description, files: [skillFile, ...extras] });
  }

  if (skills.length === 0) skills.push(fallbackSkill(config, pages, base));
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, diagnostics };
}

/**
 * The mechanical fallback (SK-3): a page directory under a spec-valid name, so
 * a zero-config site still presents something an agent can load. The
 * `readsmith-generated: fallback` marker is what the skill generator's
 * overwrite gate looks for.
 */
function fallbackSkill(config: SiteConfig, pages: PageModel[], base: string): Skill {
  const name = skillNameOf(config.site.name);
  const siteDescription = config.site.description ?? `Documentation for ${config.site.name}.`;
  const trigger = ` Use when working with ${config.site.name} or answering questions from its documentation.`;
  const description = (siteDescription + trigger).slice(0, SKILL_DESCRIPTION_MAX);
  const lines = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "metadata:",
    "  readsmith-generated: fallback",
    "---",
    "",
    `# ${config.site.name}`,
    "",
    "Reference the following documentation pages to answer questions.",
    "",
  ];
  for (const p of pages) {
    lines.push(
      `- [${p.title}](${absUrl(base, p.url)})${p.description ? `: ${p.description}` : ""}`,
    );
  }
  return {
    name,
    description,
    files: [{ path: "SKILL.md", content: `${lines.join("\n")}\n` }],
  };
}

function pickTitle(
  frontmatter: Record<string, unknown>,
  body: Root,
  slug: string,
  siteName: string,
): string {
  if (typeof frontmatter.title === "string" && frontmatter.title.trim()) {
    return frontmatter.title;
  }
  let heading: string | undefined;
  visit(body, "heading", (node) => {
    if (heading === undefined) heading = mdastToString(node).trim() || undefined;
  });
  if (heading) return heading;
  if (slug === "") return siteName;
  const last = slug.split("/").pop() ?? slug;
  return last.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function slugToUrl(slug: string): string {
  return slug === "" ? "/" : `/${slug}`;
}

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
