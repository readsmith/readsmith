import { posix } from "node:path";
import type { Diagnostic, Position } from "@readsmith/model";
import GithubSlugger from "github-slugger";
import type { Root } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";

export interface TransformContext {
  /** Current page path relative to the content root, for example "guide/setup.mdx". */
  path: string;
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
  assignHeadingSlugs(body);
  resolveLinks(body, ctx, diagnostics);
  resolveImages(body, ctx, diagnostics);
  return { body, diagnostics };
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
    if (!isRelativeFileLink(url)) return;

    const hashIndex = url.indexOf("#");
    const pathPart = hashIndex === -1 ? url : url.slice(0, hashIndex);
    const anchor = hashIndex === -1 ? "" : url.slice(hashIndex);
    if (pathPart === "") return;

    const joined = posix.normalize(posix.join(dir, pathPart));
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
    node.url = pageUrl(slug) + anchor;
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
    if (!isRelativeFileLink(url) || url === "") return;

    const joined = posix.normalize(posix.join(dir, url));
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
    node.url = resolved;
  });
}

function isRelativeFileLink(url: string): boolean {
  if (url.startsWith("#")) return false; // in-page anchor
  if (url.startsWith("/")) return false; // already absolute-internal
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false; // has a scheme (http:, mailto:, tel:)
  return true;
}

function pageUrl(slug: string): string {
  return slug === "" ? "/" : `/${slug}`;
}

function nodePosition(node: {
  position?: { start?: { line: number; column: number } };
}): Position | undefined {
  const s = node.position?.start;
  return s ? { line: s.line, col: s.column } : undefined;
}
