import type { Diagnostic } from "@readsmith/model";
import type { ElementContent, Root as HastRoot, Properties, RootContent } from "hast";
import { fromHtml } from "hast-util-from-html";
import { sanitize } from "hast-util-sanitize";
import { toHtml } from "hast-util-to-html";
import { h } from "hastscript";
import type { Root } from "mdast";
import { type Options, type State, toHast } from "mdast-util-to-hast";
import { visit } from "unist-util-visit";
import { highlightCode } from "./highlight.js";

/**
 * P6 Render (self-host, owner-trust build). Turns a transformed page AST into
 * static HTML plus an island manifest, binding components from a registry.
 *
 * M1 executes NO customer JavaScript: MDX `{expr}` resolves only as a scope
 * member lookup, `import`/`export` never run, and components come from the
 * registry, not from evaluated modules. That closes the code-execution attack
 * surface (dangerous imports, build-time egress, ambient globals) by
 * construction rather than by sandboxing. Sandboxed evaluation of untrusted
 * MDX (multi-tenant hosting) and its resource caps are a later, separate path.
 */

/** A bound component: given resolved props and rendered children, produce hast. */
export type ComponentRender = (args: {
  name: string;
  props: Props;
  children: ElementContent[];
}) => ElementContent | ElementContent[] | undefined;

export interface RegisteredComponent {
  /** Server-render for static HTML (and as the pre-hydration shell for islands). */
  render?: ComponentRender;
  /** Interactive: emit a hydration mount and a manifest entry so the client attaches. */
  island?: boolean;
}

export type ComponentRegistry = Record<string, RegisteredComponent>;

export type Props = Record<string, unknown>;

/** One interactive component instance to hydrate on the client. */
export interface IslandInstance {
  id: string;
  component: string;
  props: Record<string, unknown>;
}

/** Interactive components on the page; empty means the page ships zero JS. */
export interface IslandManifest {
  islands: IslandInstance[];
}

export interface RenderContext {
  path: string;
  /**
   * Author trust. `owner` is the site operator's own content (raw HTML passes
   * through, under the serving CSP). `contributor`/`preview` (PR authors,
   * previews) is sanitized so a malicious contribution cannot XSS readers.
   */
  trust: "owner" | "contributor" | "preview";
  /** Values exposed to `{expr}` and to expression-valued props. No secrets. */
  scope?: Record<string, unknown>;
  registry: ComponentRegistry;
  /** HTML tag names an author may use directly. Defaults to a safe set. */
  allowedHtmlElements?: Set<string>;
  themes?: { light: string; dark: string };
  /** How to handle an unregistered component: an error placeholder or drop-through. */
  unknownComponent?: "placeholder" | "passthrough";
  /** Enables the incremental-build cache. Skips re-render on a hit. */
  cacheKey?: string;
  cache?: RenderCache;
}

export interface RenderCache {
  get(key: string): RenderResult | undefined;
  set(key: string, value: RenderResult): void;
}

export interface RenderResult {
  html: string;
  hydration: IslandManifest;
  diagnostics: Diagnostic[];
  /**
   * Whether the output may be cached. Always true in M1 (render is pure, no JS
   * runs); nondeterminism detection arrives with sandboxed evaluation.
   */
  cacheable: boolean;
}

const DEFAULT_HTML_ELEMENTS = new Set([
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "code",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "picture",
  "pre",
  "s",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
  "video",
]);

/** A dotted identifier path, for example `product.name`. Not a general expression. */
const SCOPE_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/**
 * Render a transformed page (post P2/P3, code already ready for P5) to static
 * HTML and an island manifest. Never throws: compile, unknown-component, and
 * per-component render failures become diagnostics with fallbacks so one bad
 * page or component never blanks the output.
 */
export async function render(body: Root, ctx: RenderContext): Promise<RenderResult> {
  if (ctx.cacheKey && ctx.cache) {
    const hit = ctx.cache.get(ctx.cacheKey);
    if (hit) return hit;
  }

  const diagnostics: Diagnostic[] = [];
  const islands: IslandInstance[] = [];
  const scope = ctx.scope ?? {};
  const allowedHtml = ctx.allowedHtmlElements ?? DEFAULT_HTML_ELEMENTS;
  const unknownMode = ctx.unknownComponent ?? "placeholder";

  // Work on a clone so the caller's AST is never mutated (determinism, reuse).
  const tree = structuredClone(body);
  await highlightCodeNodes(tree, ctx.themes, diagnostics);

  let islandCount = 0;
  const nextIslandId = (name: string) => `${name}-${islandCount++}`;

  const asChildren = (state: State, node: unknown): ElementContent[] =>
    (state.all as (n: unknown) => ElementContent[])(node);

  const renderComponent = (
    entry: RegisteredComponent,
    name: string,
    props: Props,
    children: ElementContent[],
  ): ElementContent | ElementContent[] | undefined => {
    if (!entry.render) return children;
    try {
      return entry.render({ name, props, children });
    } catch (err) {
      diagnostics.push({
        severity: "error",
        code: "component-render-error",
        message: `<${name}> failed to render: ${(err as Error).message}`,
        source: ctx.path,
      });
      return errorPlaceholder(`Failed to render <${name}>`);
    }
  };

  const jsxHandler = (
    state: State,
    node: unknown,
  ): ElementContent | ElementContent[] | undefined => {
    const el = node as MdxJsxElement;
    if (!el.name) return asChildren(state, node); // fragment <>...</>
    const props = buildProps(el.attributes ?? [], scope, ctx.path, diagnostics);
    const children = asChildren(state, node);
    const entry = ctx.registry[el.name];

    if (!entry) {
      const lower = el.name.toLowerCase();
      if (el.name === lower && allowedHtml.has(lower)) {
        return h(lower, htmlProps(props, ctx.trust) as Properties, children);
      }
      diagnostics.push({
        severity: "warning",
        code: "unknown-component",
        message: `Unknown component <${el.name}>.`,
        source: ctx.path,
      });
      if (unknownMode === "passthrough") {
        return children.length > 0 ? children : undefined;
      }
      return errorPlaceholder(`Unknown component <${el.name}>`);
    }

    if (entry.island) {
      const id = nextIslandId(el.name);
      islands.push({ id, component: el.name, props: serializableProps(props) });
      const shell = toArray(renderComponent(entry, el.name, props, children));
      return h("div", { "data-island": el.name, "data-island-id": id }, shell);
    }

    return renderComponent(entry, el.name, props, children);
  };

  const expressionHandler = (_state: State, node: unknown): ElementContent | undefined => {
    const value = (node as { value?: string }).value ?? "";
    const resolved = resolveScope(value, scope);
    if (resolved.comment) return undefined;
    if (!resolved.ok) {
      diagnostics.push({
        severity: "warning",
        code: "unresolved-expression",
        message: `Expression \`${value.trim()}\` did not resolve to a scope value.`,
        source: ctx.path,
      });
      return { type: "text", value: "" };
    }
    return { type: "text", value: resolved.value == null ? "" : String(resolved.value) };
  };

  const htmlHandler = (
    _state: State,
    node: unknown,
  ): RootContent | ElementContent[] | undefined => {
    const raw = (node as { value?: string }).value ?? "";
    if (ctx.trust === "owner") {
      return { type: "raw", value: raw } as RootContent;
    }
    if (/<script\b|\son\w+\s*=|javascript:/i.test(raw)) {
      diagnostics.push({
        severity: "info",
        code: "sanitized-html",
        message: "Raw HTML was sanitized for a non-owner author.",
        source: ctx.path,
      });
    }
    const parsed = sanitize(fromHtml(raw, { fragment: true })) as HastRoot;
    return parsed.children as ElementContent[];
  };

  const codeHandler = (_state: State, node: unknown): ElementContent => {
    const n = node as {
      data?: { hastPre?: ElementContent };
      meta?: string | null;
      lang?: string | null;
      value?: string;
    };

    // A ```mermaid fence is a diagram, not code: emit a container carrying the
    // source, which the Mermaid island renders to SVG on the client.
    if ((n.lang ?? "").trim().toLowerCase() === "mermaid") {
      return h("div", { className: ["rs-mermaid"], "data-rs-mermaid": "" }, [
        { type: "text", value: n.value ?? "" },
      ]);
    }

    const pre =
      n.data?.hastPre ??
      h("pre", { className: ["shiki"] }, [h("code", [{ type: "text", value: n.value ?? "" }])]);
    const lang = (n.lang ?? "").trim();
    const title = parseCodeTitle(n.meta ?? undefined);

    const figureChildren: ElementContent[] = [];
    if (title) {
      const bar: ElementContent[] = [
        h("span", { className: ["rs-code__file"] }, [{ type: "text", value: title }]),
      ];
      if (lang)
        bar.push(h("span", { className: ["rs-code__lang"] }, [{ type: "text", value: lang }]));
      figureChildren.push(h("figcaption", { className: ["rs-code__bar"] }, bar));
    }
    figureChildren.push(pre);

    const props: Properties = { className: ["rs-code"] };
    if (lang) props["data-lang"] = lang;
    return h("figure", props, figureChildren);
  };

  const esmHandler = (_state: State, node: unknown): undefined => {
    const value = (node as { value?: string }).value ?? "";
    if (/^\s*import\b/.test(value)) {
      diagnostics.push({
        severity: "warning",
        code: "import-ignored",
        message: "`import` is not executed; components resolve through the registry.",
        source: ctx.path,
      });
    }
    return undefined;
  };

  const handlers = {
    mdxJsxFlowElement: jsxHandler,
    mdxJsxTextElement: jsxHandler,
    mdxFlowExpression: expressionHandler,
    mdxTextExpression: expressionHandler,
    mdxjsEsm: esmHandler,
    html: htmlHandler,
    code: codeHandler,
  };

  const hast = toHast(tree, {
    handlers: handlers as unknown as Options["handlers"],
    allowDangerousHtml: ctx.trust === "owner",
  });

  const html = toHtml(hast, { allowDangerousHtml: ctx.trust === "owner" });

  const result: RenderResult = {
    html,
    hydration: { islands },
    diagnostics,
    cacheable: true,
  };
  if (ctx.cacheKey && ctx.cache) ctx.cache.set(ctx.cacheKey, result);
  return result;
}

/**
 * Highlight every code block ahead of the sync AST-to-hast conversion, storing
 * the resulting hast `<pre>` on the node. Reuses P5 so line ranges, the
 * unknown-language fallback, and escaping stay in one place.
 */
async function highlightCodeNodes(
  tree: Root,
  themes: { light: string; dark: string } | undefined,
  diagnostics: Diagnostic[],
): Promise<void> {
  const nodes: CodeNode[] = [];
  visit(tree, "code", (node) => {
    // mermaid fences are rendered as diagrams, not highlighted code
    if ((node.lang ?? "").trim().toLowerCase() === "mermaid") return;
    nodes.push(node as unknown as CodeNode);
  });

  await Promise.all(
    nodes.map(async (node) => {
      const result = await highlightCode(
        { code: node.value ?? "", lang: node.lang ?? undefined, meta: node.meta ?? undefined },
        themes ? { themes } : undefined,
      );
      diagnostics.push(...result.diagnostics);
      const parsed = fromHtml(result.html, { fragment: true });
      const pre = parsed.children.find((c) => c.type === "element");
      if (pre) {
        node.data = { ...(node.data ?? {}), hastPre: pre };
      }
    }),
  );
}

/** Map component attributes to props, resolving expression values against scope. */
function buildProps(
  attributes: MdxAttribute[],
  scope: Record<string, unknown>,
  path: string,
  diagnostics: Diagnostic[],
): Props {
  const props: Props = {};
  for (const attr of attributes) {
    if (attr.type === "mdxJsxExpressionAttribute") {
      diagnostics.push({
        severity: "warning",
        code: "spread-attribute-unsupported",
        message: "Spread attributes are not supported.",
        source: path,
      });
      continue;
    }
    if (!attr.name) continue;
    const value = attr.value;
    if (value == null) {
      props[attr.name] = true; // bare boolean attribute
      continue;
    }
    if (typeof value === "string") {
      props[attr.name] = value;
      continue;
    }
    const resolved = resolveScope(value.value, scope);
    if (resolved.comment) continue;
    if (!resolved.ok) {
      diagnostics.push({
        severity: "warning",
        code: "unresolved-expression",
        message: `Attribute \`${attr.name}\` expression did not resolve to a scope value.`,
        source: path,
      });
      continue;
    }
    props[attr.name] = resolved.value;
  }
  return props;
}

/**
 * Resolve an MDX expression as a literal or a dotted scope path. This is the
 * whole of expression support: there is no evaluation, so `process`, `window`,
 * `fetch`, and `require` are simply undefined references, not powers.
 */
function resolveScope(
  raw: string,
  scope: Record<string, unknown>,
): { ok: boolean; value?: unknown; comment?: boolean } {
  const expr = raw.trim();
  if (expr === "" || expr.startsWith("/*") || expr.startsWith("//"))
    return { ok: false, comment: true };
  if (
    (expr.startsWith('"') && expr.endsWith('"')) ||
    (expr.startsWith("'") && expr.endsWith("'"))
  ) {
    return { ok: true, value: expr.slice(1, -1) };
  }
  if (/^-?\d+(?:\.\d+)?$/.test(expr)) return { ok: true, value: Number(expr) };
  if (expr === "true" || expr === "false") return { ok: true, value: expr === "true" };
  if (expr === "null") return { ok: true, value: null };
  if (!SCOPE_PATH.test(expr)) return { ok: false };

  let cur: unknown = scope;
  for (const part of expr.split(".")) {
    if (cur == null || typeof cur !== "object" || !Object.hasOwn(cur, part)) {
      return { ok: false };
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return { ok: true, value: cur };
}

/** Keep only JSON-serializable props for the client payload (no secrets, no closures). */
function serializableProps(props: Props): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    try {
      const json = JSON.stringify(value);
      if (json === undefined) continue;
      out[key] = JSON.parse(json);
    } catch {
      // drop non-serializable values (functions, cycles, symbols)
    }
  }
  return out;
}

/** Sanitize props for a raw HTML element: drop event handlers and unsafe URLs. */
function htmlProps(props: Props, trust: RenderContext["trust"]): Props {
  if (trust === "owner") return props;
  const out: Props = {};
  for (const [key, value] of Object.entries(props)) {
    if (/^on/i.test(key)) continue; // no inline event handlers
    if (
      (key === "href" || key === "src") &&
      typeof value === "string" &&
      /^\s*javascript:/i.test(value)
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function errorPlaceholder(message: string): ElementContent {
  return h("div", { className: ["rs-render-error"], "data-error": message }, [
    { type: "text", value: message },
  ]);
}

function toArray(value: ElementContent | ElementContent[] | undefined): ElementContent[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Read a code fence's `title="..."` (or `filename="..."`) meta, if present. */
function parseCodeTitle(meta?: string): string | undefined {
  if (!meta) return undefined;
  const match = meta.match(/(?:title|filename)="([^"]*)"/);
  return match?.[1]?.trim() || undefined;
}

interface CodeNode {
  value?: string;
  lang?: string | null;
  meta?: string | null;
  data?: Record<string, unknown>;
}

interface MdxAttributeValueExpression {
  type: "mdxJsxAttributeValueExpression";
  value: string;
}

interface MdxAttribute {
  type: "mdxJsxAttribute" | "mdxJsxExpressionAttribute";
  name?: string;
  value?: string | null | MdxAttributeValueExpression;
}

interface MdxJsxElement {
  type: string;
  name: string | null;
  attributes?: MdxAttribute[];
}
