import type { NormalizedSchema } from "@readsmith/model";
import { esc } from "../shell/util.js";

/**
 * SchemaViewer (view mode): render a NormalizedSchema as reference documentation.
 * SSR-first static HTML, so it server-renders for SEO and fast first paint; the
 * only interactive part is the oneOf/anyOf variant selector, which reuses the
 * Tabs island. Composition, deep nesting, and cycles are handled: `ref` nodes
 * expand from the spec's schema map up to a depth budget, and cyclic or too-deep
 * refs render as a terminal reference chip rather than recursing forever.
 */

export interface SchemaContext {
  /** The spec's named component schemas, the targets of `ref` nodes. */
  schemas: Record<string, NormalizedSchema>;
  /** Request forms omit readOnly fields; response forms omit writeOnly fields. */
  role?: "request" | "response";
  /** Maximum ref-expansion depth before a reference renders as a chip. */
  depthBudget?: number;
}

interface RenderState {
  depth: number;
  seen: ReadonlySet<string>;
}

/** Render a schema to an HTML string. Entry point for the reference renderer. */
export function renderSchema(schema: NormalizedSchema, ctx: SchemaContext): string {
  return `<div class="rs-schema">${renderNode(schema, ctx, { depth: 0, seen: new Set() })}</div>`;
}

function renderNode(schema: NormalizedSchema, ctx: SchemaContext, state: RenderState): string {
  return node(`${typeSummary(schema)}${meta(schema)}`, schemaBody(schema, ctx, state));
}

/**
 * The nested body of a schema, resolving a `ref` to its target's children so a
 * referenced object or composition expands wherever it appears (a property, an
 * array item, a response). Terminal when the ref is cyclic, already on the path,
 * or past the depth budget.
 */
function schemaBody(schema: NormalizedSchema, ctx: SchemaContext, state: RenderState): string {
  if (schema.ref !== undefined) {
    const name = schema.ref;
    const budget = ctx.depthBudget ?? 8;
    const expandable =
      !schema.cyclic && !state.seen.has(name) && state.depth < budget && !!ctx.schemas[name];
    if (!expandable) return "";
    const target = ctx.schemas[name] as NormalizedSchema;
    return renderChildren(target, ctx, {
      depth: state.depth + 1,
      seen: new Set([...state.seen, name]),
    });
  }
  return renderChildren(schema, ctx, state);
}

function node(head: string, children: string): string {
  return `<div class="rs-schema__node"><div class="rs-schema__head">${head}</div>${children}</div>`;
}

function renderChildren(schema: NormalizedSchema, ctx: SchemaContext, state: RenderState): string {
  const parts: string[] = [];
  if (schema.conflicts && schema.conflicts.length > 0)
    parts.push(renderConflicts(schema.conflicts));
  if (schema.composition) parts.push(renderVariants(schema, ctx, state));
  if (schema.properties) parts.push(renderProps(schema, ctx, state));
  if (schema.items) parts.push(renderItems(schema.items, ctx, state));
  if (typeof schema.additionalProperties === "object") {
    parts.push(
      `<div class="rs-schema__extra"><div class="rs-schema__items-label">additional properties</div>${renderNode(
        schema.additionalProperties,
        ctx,
        deeper(state),
      )}</div>`,
    );
  } else if (schema.additionalProperties === false) {
    parts.push('<div class="rs-schema__note">No additional properties.</div>');
  }
  if (schema.enum) parts.push(renderEnum(schema.enum));
  return parts.join("");
}

function renderProps(schema: NormalizedSchema, ctx: SchemaContext, state: RenderState): string {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const rows: string[] = [];
  for (const [name, prop] of Object.entries(props)) {
    if (ctx.role === "response" && prop.writeOnly) continue;
    if (ctx.role === "request" && prop.readOnly) continue;
    rows.push(renderProp(name, prop, required.has(name), ctx, state));
  }
  if (rows.length === 0) return "";
  return `<div class="rs-schema__props">${rows.join("")}</div>`;
}

function renderProp(
  name: string,
  prop: NormalizedSchema,
  isRequired: boolean,
  ctx: SchemaContext,
  state: RenderState,
): string {
  const head = `<code class="rs-schema__key">${esc(name)}</code><span class="rs-schema__prop-type">${typeSummary(
    prop,
  )}</span>${isRequired ? '<span class="rs-schema__req">required</span>' : ""}${meta(prop)}`;
  const description = prop.description
    ? `<p class="rs-schema__desc">${esc(prop.description)}</p>`
    : "";
  const body = schemaBody(prop, ctx, deeper(state));

  if (body === "") {
    return `<div class="rs-schema__prop"><div class="rs-schema__prop-head">${head}</div>${description}</div>`;
  }
  // A property with structure is a native disclosure: collapsed, expand on demand.
  return `<details class="rs-schema__prop rs-schema__prop--nested"><summary class="rs-schema__prop-head">${head}</summary>${description}<div class="rs-schema__prop-body">${body}</div></details>`;
}

function renderItems(items: NormalizedSchema, ctx: SchemaContext, state: RenderState): string {
  return `<div class="rs-schema__items"><div class="rs-schema__items-label">items</div>${renderNode(
    items,
    ctx,
    deeper(state),
  )}</div>`;
}

function renderVariants(schema: NormalizedSchema, ctx: SchemaContext, state: RenderState): string {
  const composition = schema.composition;
  if (!composition) return "";
  const kind = composition.kind === "oneOf" ? "One of" : "Any of";
  const discriminator = composition.discriminator;
  const note = discriminator
    ? `<div class="rs-schema__disc">Discriminated by <code>${esc(discriminator.propertyName)}</code></div>`
    : "";

  if (composition.variants.length === 0) {
    return `<div class="rs-schema__variants"><div class="rs-schema__comp-kind">${kind}</div>${note}</div>`;
  }

  const labels = composition.variants.map((variant, i) => variantLabel(variant, i, discriminator));
  const tabs = labels
    .map(
      (label, i) =>
        `<button class="rs-tabs__tab" type="button" role="tab" aria-selected="${
          i === 0 ? "true" : "false"
        }" tabindex="${i === 0 ? 0 : -1}">${esc(label)}</button>`,
    )
    .join("");
  const panels = composition.variants
    .map(
      (variant, i) =>
        `<div class="rs-tab" role="tabpanel" tabindex="0" data-rs-tab-title="${esc(
          labels[i] ?? `Option ${i + 1}`,
        )}"${i === 0 ? "" : " hidden"}>${renderNode(variant, ctx, deeper(state))}</div>`,
    )
    .join("");

  return `<div class="rs-schema__variants"><div class="rs-schema__comp-kind">${kind}</div>${note}<div class="rs-schema__tabs" data-island="Tabs"><div class="rs-tabs"><div class="rs-tabs__list" role="tablist">${tabs}</div><div class="rs-tabs__panels">${panels}</div></div></div></div>`;
}

function variantLabel(
  variant: NormalizedSchema,
  index: number,
  discriminator: { mapping: Record<string, string> } | undefined,
): string {
  if (variant.title) return variant.title;
  if (variant.ref !== undefined) {
    if (discriminator) {
      const key = Object.entries(discriminator.mapping).find(([, v]) => v === variant.ref)?.[0];
      if (key) return key;
    }
    return variant.ref;
  }
  return `Option ${index + 1}`;
}

function renderEnum(values: unknown[]): string {
  const items = values.map((v) => `<code class="rs-schema__enum-val">${esc(display(v))}</code>`);
  const inline = `<div class="rs-schema__enum">${items.join("")}</div>`;
  if (values.length <= 12) {
    return `<div class="rs-schema__enum-wrap"><span class="rs-schema__enum-label">Allowed values</span>${inline}</div>`;
  }
  return `<details class="rs-schema__enum-wrap"><summary class="rs-schema__enum-label">Allowed values (${values.length})</summary>${inline}</details>`;
}

function renderConflicts(conflicts: { keyword: string; message: string }[]): string {
  const items = conflicts.map((c) => `<li>${esc(c.message)}</li>`).join("");
  return `<div class="rs-schema__warn" role="note"><span class="rs-schema__warn-label">Schema warning</span><ul>${items}</ul></div>`;
}

function typeSummary(schema: NormalizedSchema): string {
  if (schema.ref !== undefined) {
    return `<span class="rs-schema__ref">${esc(schema.ref)}</span>${
      schema.cyclic ? flag("recursive") : ""
    }`;
  }
  if (schema.composition) {
    return `<span class="rs-schema__comp">${schema.composition.kind === "oneOf" ? "one of" : "any of"}</span>`;
  }
  const types = schema.type ?? [];
  if (types.length > 0) {
    const label = `<span class="rs-schema__t">${esc(types.join(" | "))}</span>`;
    return schema.format
      ? `${label}<span class="rs-schema__fmt">${esc(schema.format)}</span>`
      : label;
  }
  if (schema.enum) return '<span class="rs-schema__t">enum</span>';
  if (schema.const !== undefined) return '<span class="rs-schema__t">const</span>';
  if (schema.properties) return '<span class="rs-schema__t">object</span>';
  if (schema.items) return '<span class="rs-schema__t">array</span>';
  return '<span class="rs-schema__t rs-schema__any">any</span>';
}

function meta(schema: NormalizedSchema): string {
  const chips: string[] = [];
  if (schema.deprecated) chips.push(flag("deprecated"));
  if (schema.readOnly) chips.push(flag("read-only"));
  if (schema.writeOnly) chips.push(flag("write-only"));

  const c = (label: string, value: unknown): void => {
    if (value !== undefined)
      chips.push(`<span class="rs-schema__chip">${label} ${esc(display(value))}</span>`);
  };
  c("min", schema.minimum);
  c("max", schema.maximum);
  c("&gt;", schema.exclusiveMinimum);
  c("&lt;", schema.exclusiveMaximum);
  c("×", schema.multipleOf);
  c("minLen", schema.minLength);
  c("maxLen", schema.maxLength);
  c("minItems", schema.minItems);
  c("maxItems", schema.maxItems);
  if (schema.uniqueItems) chips.push('<span class="rs-schema__chip">unique</span>');
  if (schema.pattern)
    chips.push(`<span class="rs-schema__chip">pattern <code>${esc(schema.pattern)}</code></span>`);
  if (schema.default !== undefined) {
    chips.push(
      `<span class="rs-schema__chip">default <code>${esc(display(schema.default))}</code></span>`,
    );
  }
  if (schema.example !== undefined) {
    chips.push(
      `<span class="rs-schema__chip">example <code>${esc(display(schema.example))}</code></span>`,
    );
  }
  return chips.length > 0 ? `<span class="rs-schema__meta">${chips.join("")}</span>` : "";
}

function flag(label: string): string {
  return `<span class="rs-schema__flag rs-schema__flag--${label.replace(/[^a-z]/g, "")}">${label}</span>`;
}

function deeper(state: RenderState): RenderState {
  return { depth: state.depth + 1, seen: state.seen };
}

function display(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  return JSON.stringify(value);
}
