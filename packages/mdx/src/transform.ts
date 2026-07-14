import { posix } from "node:path";
import type { Diagnostic, Position } from "@readsmith/model";
import GithubSlugger from "github-slugger";
import type { Root } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";

export interface TransformContext {
  /** Current page path relative to the content root, for example "guide/setup.mdx". */
  path: string;
  /** The site's base path when hosted under a parent domain's subpath (spec
   * subpath-hosting SP-3): prefixes every resolved page and asset URL. */
  basePath?: string;
  /**
   * Resolve an internal link target (a content-relative path without extension)
   * to a URL slug, or null when no such page exists. When omitted, links are
   * left untouched.
   */
  resolvePage?: (targetPathNoExt: string) => string | null;
  /**
   * Resolve a relative image target to its served URL. Receives a normalized
   * content-root-relative path, which may escape the root (`../media/a.gif`)
   * because real repos keep images beside the code. Returns null when nothing
   * publishes that path. When omitted, images are left untouched.
   */
  resolveAsset?: (targetPath: string) => string | null;
  /**
   * Last resort for a relative `.md` link that matches no page. Receives the same
   * normalized path (extension intact). Returns a URL, typically on the forge, or
   * null to let it be reported as broken. When omitted, unresolved links warn.
   */
  resolveOutsidePage?: (targetPath: string) => string | null;
  /**
   * Where the content root sits relative to the repository root ("." or "docs").
   * Needed because the home page may live above the content root, in which case
   * its relative links are repository-root relative while every other page's are
   * content-root relative. Both are canonicalized to the latter.
   */
  contentRel?: string;
}

/**
 * Express a path resolved from a page's directory in content-root-relative terms.
 * A no-op for pages inside the content root; for `../README.md` it rewrites
 * `../docs/cli.md` to `cli.md`, and leaves `../SECURITY.md` escaping (as it should).
 */
function toContentRelative(target: string, contentRel: string | undefined): string {
  if (!contentRel || contentRel === ".") return target;
  const repoRelative = posix.normalize(posix.join(contentRel, target));
  return posix.relative(contentRel, repoRelative);
}

export interface TransformResult {
  body: Root;
  diagnostics: Diagnostic[];
}

/**
 * P2 Transforms: assign heading slugs, then resolve internal links and images.
 * Runs in a defined order (slugs before links) and mutates the tree in place.
 */
export function transform(body: Root, ctx: TransformContext): TransformResult {
  const diagnostics: Diagnostic[] = [];
  resolveGitHubAlerts(body);
  assignHeadingSlugs(body);
  resolveLinks(body, ctx, diagnostics);
  resolveImages(body, ctx, diagnostics);
  return { body, diagnostics };
}

/** GitHub alert marker to callout kind. IMPORTANT maps to info (both are the
 * "read this" accent); CAUTION to danger (both mean consequences). */
const ALERT_KINDS: Record<string, string> = {
  NOTE: "note",
  TIP: "tip",
  IMPORTANT: "info",
  WARNING: "warning",
  CAUTION: "danger",
};

/**
 * GitHub-flavored alerts (`> [!NOTE]` blockquotes) become callouts, so the
 * same source renders as a native alert on github.com and as a first-class
 * callout here: docs that live in a repository never have to choose. Works in
 * plain `.md` and `.mdx` alike (the render stage dispatches the synthesized
 * component node regardless of source format).
 */
export function resolveGitHubAlerts(body: Root): void {
  visit(body, "blockquote", (node, index, parent) => {
    if (!parent || index === undefined) return;
    const [first, ...blocks] = node.children;
    if (!first || first.type !== "paragraph") return;
    const [lead, ...inline] = first.children;
    if (!lead || lead.type !== "text") return;
    const match = lead.value.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*?(?:\n|$)/);
    if (!match) return;

    // Strip the marker line; whatever follows it (same paragraph or later
    // blocks) is the callout body.
    const remainder = lead.value.slice(match[0].length);
    let leadInline = inline;
    if (!remainder && leadInline[0]?.type === "break") leadInline = leadInline.slice(1);
    const leadChildren = remainder
      ? [{ type: "text", value: remainder } as (typeof first.children)[number], ...leadInline]
      : leadInline;
    const children = [
      ...(leadChildren.length ? [{ ...first, children: leadChildren }] : []),
      ...blocks,
    ];

    parent.children[index] = {
      type: "mdxJsxFlowElement",
      name: "Callout",
      attributes: [
        { type: "mdxJsxAttribute", name: "type", value: ALERT_KINDS[match[1] ?? ""] ?? "note" },
      ],
      children,
      position: node.position,
    } as unknown as (typeof parent.children)[number];
  });
}

/**
 * Assign a page-unique, deterministic slug to every heading, using the same
 * algorithm as headings anywhere else in the pipeline (github-slugger). The id
 * is stored on `data.id` and mirrored to `data.hProperties.id` for later HTML.
 */
export function assignHeadingSlugs(body: Root): void {
  const slugger = new GithubSlugger();
  visit(body, "heading", (node) => {
    const id = slugger.slug(mdastToString(node));
    if (!node.data) node.data = {};
    const data = node.data as Record<string, unknown>;
    data.id = id;
    data.hProperties = { ...((data.hProperties as Record<string, unknown>) ?? {}), id };
  });
}

/**
 * Resolve relative internal links to canonical page URLs. External links,
 * absolute paths, mailto/tel, and pure anchors are left untouched.
 *
 * A relative link matching no page gets one more chance through
 * `resolveOutsidePage`, which handles the common case of a docs page pointing at
 * a real repository file that is not a docs page (`../SECURITY.md`). Failing
 * that, it produces a diagnostic and is left as is.
 */
export function resolveLinks(body: Root, ctx: TransformContext, diagnostics: Diagnostic[]): void {
  const resolve = ctx.resolvePage;
  if (!resolve) return;
  const dir = posix.dirname(ctx.path);

  visit(body, "link", (node) => {
    const url = node.url;
    // A root-relative internal link (`/guide`) is site-root-relative: on a
    // subpath deploy it must carry the base path, exactly like a resolved
    // relative link does. Left untouched it would point above the site.
    if (isAbsoluteInternalLink(url)) {
      node.url = withBasePath(url, ctx.basePath ?? "");
      return;
    }
    if (!isRelativeFileLink(url)) return;

    const hashIndex = url.indexOf("#");
    const pathPart = hashIndex === -1 ? url : url.slice(0, hashIndex);
    const anchor = hashIndex === -1 ? "" : url.slice(hashIndex);
    if (pathPart === "") return;

    const joined = toContentRelative(posix.normalize(posix.join(dir, pathPart)), ctx.contentRel);
    const noExt = joined.replace(/\.(md|mdx)$/i, "");
    const slug = resolve(noExt);

    if (slug === null) {
      const outside = ctx.resolveOutsidePage?.(joined);
      if (outside) {
        node.url = outside + anchor;
        return;
      }
      diagnostics.push({
        severity: "warning",
        code: "broken-link",
        message: `Link "${url}" does not resolve to a known page.`,
        pos: nodePosition(node),
        source: ctx.path,
      });
      return;
    }
    node.url = pageUrl(slug, ctx.basePath ?? "") + anchor;
  });
}

/**
 * Rewrite relative image URLs to the URLs their files are actually served at.
 * Without this, `![x](../media/a.gif)` is handed to the browser verbatim and
 * resolves against the *page* URL, which is not where the asset lives.
 *
 * Absolute paths and anything with a scheme (a shields.io badge) are untouched.
 */
export function resolveImages(body: Root, ctx: TransformContext, diagnostics: Diagnostic[]): void {
  const resolve = ctx.resolveAsset;
  if (!resolve) return;
  const dir = posix.dirname(ctx.path);

  visit(body, "image", (node) => {
    const url = node.url;
    // A root-relative image (`/logo.svg`) is served from the site root, so on a
    // subpath deploy it needs the base path too.
    if (isAbsoluteInternalLink(url)) {
      node.url = withBasePath(url, ctx.basePath ?? "");
      return;
    }
    if (!isRelativeFileLink(url) || url === "") return;

    const joined = toContentRelative(posix.normalize(posix.join(dir, url)), ctx.contentRel);
    const resolved = resolve(joined);
    if (resolved === null) {
      diagnostics.push({
        severity: "warning",
        code: "broken-asset",
        message: `Image "${url}" is outside the content root and no asset mount publishes it.`,
        pos: nodePosition(node),
        source: ctx.path,
      });
      return;
    }
    node.url = (ctx.basePath ?? "") + resolved;
  });
}

function isRelativeFileLink(url: string): boolean {
  if (url.startsWith("#")) return false; // in-page anchor
  if (url.startsWith("/")) return false; // already absolute-internal
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false; // has a scheme (http:, mailto:, tel:)
  return true;
}

/** A site-root-relative internal URL (`/guide`), not protocol-relative (`//host`). */
function isAbsoluteInternalLink(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

/** Prefix a root-relative URL with the base path, once (a no-op at the root). */
function withBasePath(url: string, base: string): string {
  if (!base || url === base || url.startsWith(`${base}/`)) return url;
  return base + url;
}

function pageUrl(slug: string, base: string): string {
  return slug === "" ? base || "/" : `${base}/${slug}`;
}

function nodePosition(node: {
  position?: { start?: { line: number; column: number } };
}): Position | undefined {
  const s = node.position?.start;
  return s ? { line: s.line, col: s.column } : undefined;
}
