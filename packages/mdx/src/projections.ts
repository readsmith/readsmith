import { contentHash } from "@readsmith/model";
import type { Root, RootContent } from "mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import { toString as mdastToString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";

/** ~500 token target per chunk; a section larger than this is split on block boundaries. */
const MAX_TOKENS = 512;
/** A cheap, deterministic token estimate (roughly 4 characters per token). */
const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

export interface TocNode {
  text: string;
  anchor: string;
  depth: number;
  children: TocNode[];
}

export interface Chunk {
  id: string;
  page_id: string;
  path: string;
  header_path: string[];
  anchor: string;
  text: string;
}

export interface ProjectContext {
  path: string;
}

export interface Projections {
  toc: TocNode[];
  rawMd: string;
  chunks: Chunk[];
}

/** P4: derive the TOC, the raw Markdown, and the search chunks from one AST. */
export function project(body: Root, ctx: ProjectContext): Projections {
  return {
    toc: buildToc(body),
    rawMd: toRawMarkdown(body),
    chunks: buildChunks(body, ctx),
  };
}

/**
 * Build a nested table of contents from headings within the depth range. Each
 * anchor is read from the heading's `data.id`, which P2 assigned, so TOC anchors
 * match in-page link anchors and chunk anchors exactly.
 */
export function buildToc(body: Root, opts?: { minDepth?: number; maxDepth?: number }): TocNode[] {
  const minDepth = opts?.minDepth ?? 2;
  const maxDepth = opts?.maxDepth ?? 3;

  const root: TocNode[] = [];
  const stack: TocNode[] = [];

  visit(body, "heading", (node) => {
    if (node.depth < minDepth || node.depth > maxDepth) return;
    const item: TocNode = {
      text: mdastToString(node),
      anchor: headingAnchor(node),
      depth: node.depth,
      children: [],
    };
    while (stack.length > 0 && (stack[stack.length - 1] as TocNode).depth >= node.depth)
      stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(item);
    else root.push(item);
    stack.push(item);
  });

  return root;
}

/** Serialize the AST to clean Markdown, unwrapping MDX components to their content. */
export function toRawMarkdown(body: Root): string {
  const clone = structuredClone(body);
  stripMdx(clone as unknown as AnyNode);
  return toMarkdown(clone, { extensions: [gfmToMarkdown()] });
}

/**
 * Split the document into header-aligned chunks with citation metadata. Sections
 * larger than the token budget are split on block boundaries (never mid-block,
 * so a code block or table stays whole).
 */
export function buildChunks(body: Root, ctx: ProjectContext): Chunk[] {
  const chunks: Chunk[] = [];
  const headingPath: { depth: number; text: string; anchor: string }[] = [];
  let ord = 0;

  for (const section of splitIntoSections(body.children)) {
    let anchor = "";
    if (section.heading) {
      const d = section.heading.depth;
      while (
        headingPath.length > 0 &&
        (headingPath[headingPath.length - 1] as { depth: number }).depth >= d
      ) {
        headingPath.pop();
      }
      anchor = headingAnchor(section.heading);
      headingPath.push({ depth: d, text: mdastToString(section.heading), anchor });
    }
    const headerPath = headingPath.map((h) => h.text);
    const nodes = section.heading ? [section.heading, ...section.nodes] : section.nodes;

    for (const piece of splitBySize(nodes)) {
      const text = mdastToString({ type: "root", children: piece }).trim();
      if (!text) continue;
      chunks.push({
        id: contentHash({ path: ctx.path, ord }),
        page_id: ctx.path,
        path: ctx.path,
        header_path: headerPath,
        anchor,
        text,
      });
      ord++;
    }
  }

  return chunks;
}

type AnyNode = { type: string; children?: AnyNode[] };

function stripMdx(node: AnyNode): void {
  if (!Array.isArray(node.children)) return;
  const out: AnyNode[] = [];
  for (const child of node.children) {
    if (
      child.type === "mdxjsEsm" ||
      child.type === "mdxFlowExpression" ||
      child.type === "mdxTextExpression"
    ) {
      continue;
    }
    if (child.type === "mdxJsxFlowElement" || child.type === "mdxJsxTextElement") {
      stripMdx(child);
      out.push(...(child.children ?? []));
      continue;
    }
    stripMdx(child);
    out.push(child);
  }
  node.children = out;
}

function headingAnchor(node: unknown): string {
  const id = (node as { data?: { id?: unknown } }).data?.id;
  return typeof id === "string" ? id : "";
}

interface Section {
  heading?: RootContent & { type: "heading"; depth: number };
  nodes: RootContent[];
}

function splitIntoSections(children: RootContent[]): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const node of children) {
    if (node.type === "heading") {
      if (current) sections.push(current);
      current = { heading: node, nodes: [] };
    } else {
      if (!current) current = { nodes: [] };
      current.nodes.push(node);
    }
  }
  if (current) sections.push(current);
  return sections;
}

function splitBySize(nodes: RootContent[]): RootContent[][] {
  const pieces: RootContent[][] = [];
  let cur: RootContent[] = [];
  let curTokens = 0;
  for (const node of nodes) {
    const t = estimateTokens(mdastToString(node));
    if (cur.length > 0 && curTokens + t > MAX_TOKENS) {
      pieces.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(node);
    curTokens += t;
  }
  if (cur.length > 0) pieces.push(cur);
  return pieces;
}
