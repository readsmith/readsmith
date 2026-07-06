import type { Diagnostic } from "@readsmith/model";
import type { Root } from "mdast";
import { visit } from "unist-util-visit";

/** Bound on how deep snippets may nest before we stop and report. */
const MAX_SNIPPET_DEPTH = 10;

export interface SnippetVarContext {
  /** Current page path, used as the diagnostic source. */
  path: string;
  /** Config-level variables. */
  global?: Record<string, unknown>;
  /** Page-level variables (from frontmatter). These override globals. */
  page?: Record<string, unknown>;
  /**
   * Resolve a snippet name to a freshly parsed AST, or null when it does not
   * exist. Must return a new tree each call (it is mutated per invocation).
   */
  resolveSnippet?: (name: string) => Root | null;
}

export interface SnippetVarResult {
  body: Root;
  diagnostics: Diagnostic[];
}

type AnyNode = {
  type: string;
  value?: string;
  name?: string;
  attributes?: { type: string; name?: string; value?: unknown }[];
  children?: AnyNode[];
};

const VAR_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/g;
const ATTR_PATTERN = /(\w+)="([^"]*)"/g;

/**
 * P3: expand `<Snippet file="..." />` inclusions and interpolate `{{var}}`
 * variables, at transform time. Variable interpolation runs over text nodes,
 * so `{{...}}` inside code and inline code is left literal. Snippet props are
 * passed as variables into the included snippet's scope. Cycles and excessive
 * nesting are reported, never looped.
 */
export function expandSnippetsAndVariables(body: Root, ctx: SnippetVarContext): SnippetVarResult {
  const diagnostics: Diagnostic[] = [];
  const scope = { ...(ctx.global ?? {}), ...(ctx.page ?? {}) };
  processTree(body, ctx, scope, [], diagnostics);
  return { body, diagnostics };
}

function processTree(
  tree: Root,
  ctx: SnippetVarContext,
  scope: Record<string, unknown>,
  stack: string[],
  diagnostics: Diagnostic[],
): void {
  const source = sourceLabel(ctx, stack);
  visit(tree, "text", (node) => {
    node.value = interpolate(node.value, scope, diagnostics, source);
  });
  expandChildren(tree as unknown as AnyNode, ctx, scope, stack, diagnostics);
}

function interpolate(
  value: string,
  scope: Record<string, unknown>,
  diagnostics: Diagnostic[],
  source: string,
): string {
  return value.replace(VAR_PATTERN, (_match, name: string) => {
    if (Object.hasOwn(scope, name)) {
      const v = scope[name];
      return v == null ? "" : String(v);
    }
    diagnostics.push({
      severity: "warning",
      code: "missing-variable",
      message: `Unknown variable "${name}".`,
      source,
    });
    return "";
  });
}

function expandChildren(
  parent: AnyNode,
  ctx: SnippetVarContext,
  scope: Record<string, unknown>,
  stack: string[],
  diagnostics: Diagnostic[],
): void {
  if (!Array.isArray(parent.children)) return;
  const out: AnyNode[] = [];
  for (const child of parent.children) {
    if (isSnippet(child)) {
      out.push(...inlineSnippet(child, ctx, scope, stack, diagnostics));
    } else {
      expandChildren(child, ctx, scope, stack, diagnostics);
      out.push(child);
    }
  }
  parent.children = out;
}

function isSnippet(node: AnyNode): boolean {
  if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
    return node.name === "Snippet";
  }
  return (
    node.type === "html" && typeof node.value === "string" && /^\s*<Snippet\b/i.test(node.value)
  );
}

function inlineSnippet(
  node: AnyNode,
  ctx: SnippetVarContext,
  scope: Record<string, unknown>,
  stack: string[],
  diagnostics: Diagnostic[],
): AnyNode[] {
  const source = sourceLabel(ctx, stack);
  const { name, props } = readSnippet(node, scope, diagnostics, source);

  if (!name) {
    diagnostics.push({
      severity: "warning",
      code: "snippet-no-file",
      message: "Snippet is missing a file attribute.",
      source,
    });
    return [];
  }
  if (stack.includes(name)) {
    diagnostics.push({
      severity: "error",
      code: "snippet-cycle",
      message: `Snippet cycle: ${[...stack, name].join(" -> ")}.`,
      source,
    });
    return [];
  }
  if (stack.length >= MAX_SNIPPET_DEPTH) {
    diagnostics.push({
      severity: "error",
      code: "snippet-depth",
      message: `Snippet nesting exceeds ${MAX_SNIPPET_DEPTH} levels.`,
      source,
    });
    return [];
  }

  const tree = ctx.resolveSnippet?.(name) ?? null;
  if (!tree) {
    diagnostics.push({
      severity: "warning",
      code: "snippet-missing",
      message: `Snippet "${name}" was not found.`,
      source,
    });
    return [];
  }

  const childScope = { ...(ctx.global ?? {}), ...props };
  processTree(tree, ctx, childScope, [...stack, name], diagnostics);
  return (tree as unknown as AnyNode).children ?? [];
}

function readSnippet(
  node: AnyNode,
  hostScope: Record<string, unknown>,
  diagnostics: Diagnostic[],
  source: string,
): { name: string | null; props: Record<string, string> } {
  const props: Record<string, string> = {};
  let name: string | null = null;

  if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
    for (const attr of node.attributes ?? []) {
      if (attr.type === "mdxJsxAttribute" && attr.name && typeof attr.value === "string") {
        const v = interpolate(attr.value, hostScope, diagnostics, source);
        if (attr.name === "file") name = v;
        else props[attr.name] = v;
      }
    }
  } else if (typeof node.value === "string") {
    for (const m of node.value.matchAll(ATTR_PATTERN)) {
      const attrName = m[1];
      const attrValue = m[2];
      if (!attrName || attrValue === undefined) continue;
      const v = interpolate(attrValue, hostScope, diagnostics, source);
      if (attrName === "file") name = v;
      else props[attrName] = v;
    }
  }

  return { name, props };
}

function sourceLabel(ctx: SnippetVarContext, stack: string[]): string {
  const top = stack[stack.length - 1];
  return top ? `snippet:${top}` : ctx.path;
}
