import type {
  ApiResponse,
  NormalizedSchema,
  NormalizedSpec,
  Operation,
  Parameter,
  SecurityScheme,
} from "@readsmith/model";
import { esc } from "../shell/util.js";
import { operationSamples, renderCodeSamples } from "./code-samples.js";
import { type SchemaContext, renderSchema } from "./schema-viewer.js";

/*
 * Operation-level rendering: the detail column fragments (method bar, generated
 * sections) and the dark assay console for one operation, plus the hybrid-page
 * composer that puts them into the reading shell's content column. Deliberately
 * free of any shell import, so the shell can import from here without a cycle
 * (the page-level reference renderer imports the shell AND this module).
 */

const STATUS_TEXT: Record<string, string> = {
  "200": "OK",
  "201": "Created",
  "202": "Accepted",
  "204": "No content",
  "301": "Moved",
  "302": "Found",
  "304": "Not modified",
  "400": "Bad request",
  "401": "Unauthorized",
  "402": "Payment required",
  "403": "Forbidden",
  "404": "Not found",
  "409": "Conflict",
  "422": "Unprocessable",
  "429": "Too many requests",
  "500": "Server error",
  "502": "Bad gateway",
  "503": "Unavailable",
  default: "Default",
};

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M6 15V5a2 2 0 0 1 2-2h10"/></svg>';
const HALLMARK_SMALL =
  '<svg class="rs-console__hallmark" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3 L27 9 V22 L16 28 L5 22 V9 Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M11 16 L14.6 19.5 L21 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function serverBase(spec: NormalizedSpec): string {
  const url = spec.servers[0]?.url;
  if (!url) return "";
  try {
    return new URL(url).pathname.replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function verb(method: string, small = false): string {
  return `<span class="rs-method rs-method--${esc(method)}${
    small ? " rs-method--sm" : ""
  }">${esc(method.toUpperCase())}</span>`;
}

function statusClass(status: string): string {
  const c = status.charAt(0);
  if (c === "2") return "ok";
  if (c === "3") return "redirect";
  if (c === "4") return "client";
  if (c === "5") return "server";
  return "default";
}

function sectionHead(title: string, ...trailing: string[]): string {
  return `<div class="rs-op__shead"><span class="rs-eyebrow">${esc(
    title,
  )}</span><span class="rs-op__line"></span>${trailing.join("")}</div>`;
}

/** Render a group of parameters as a single spec-sheet via the SchemaViewer. */
function renderParamGroup(params: Parameter[], ctx: SchemaContext, label: string): string {
  if (params.length === 0) return "";
  const properties: Record<string, NormalizedSchema> = {};
  const required: string[] = [];
  for (const param of params) {
    const description = param.description ?? param.schema.description;
    properties[param.name] = description ? { ...param.schema, description } : param.schema;
    if (param.required) required.push(param.name);
  }
  const synthetic: NormalizedSchema = { type: ["object"], properties, required };
  return `<div class="rs-op__section">${sectionHead(`${label} parameters`)}${renderSchema(
    synthetic,
    ctx,
  )}</div>`;
}

function renderParameters(op: Operation, ctx: SchemaContext): string {
  const order: Parameter["in"][] = ["path", "query", "header", "cookie"];
  return order
    .map((loc) =>
      renderParamGroup(
        op.parameters.filter((p) => p.in === loc),
        ctx,
        loc,
      ),
    )
    .join("");
}

function renderRequestBody(op: Operation, spec: NormalizedSpec): string {
  const body = op.requestBody;
  if (!body) return "";
  const ctx: SchemaContext = { schemas: spec.schemas, role: "request" };
  const parts = Object.entries(body.content)
    .map(([, media]) => renderSchema(media.schema, ctx))
    .join("");
  const chips = `<span class="rs-chip">${esc(
    Object.keys(body.content)[0] ?? "application/json",
  )}</span>${body.required ? '<span class="rs-req">required</span>' : ""}`;
  return `<div class="rs-op__section">${sectionHead("Request body", chips)}${parts}</div>`;
}

function renderResponses(op: Operation, spec: NormalizedSpec): string {
  if (op.responses.length === 0) return "";
  const ctx: SchemaContext = { schemas: spec.schemas, role: "response" };
  const sorted = [...op.responses].sort((a, b) => a.status.localeCompare(b.status));
  const rows = sorted
    .map((response) => {
      const body = response.content
        ? Object.values(response.content)
            .map((media) => renderSchema(media.schema, ctx))
            .join("")
        : "";
      return `<div class="rs-response"><div class="rs-response__head"><span class="rs-status rs-status--${statusClass(
        response.status,
      )}"><span class="rs-dot"></span>${esc(response.status)} ${esc(
        STATUS_TEXT[response.status] ?? "",
      )}</span>${
        response.description
          ? `<span class="rs-response__desc">${esc(response.description)}</span>`
          : ""
      }</div>${body}</div>`;
    })
    .join("");
  return `<div class="rs-op__section">${sectionHead("Responses")}<div class="rs-responses">${rows}</div></div>`;
}

function renderAuth(spec: NormalizedSpec, op: Operation): string {
  const names = op.security
    ? [...new Set(op.security.flatMap((req) => Object.keys(req)))]
    : Object.keys(spec.securitySchemes);
  const schemes = names
    .map((name) => [name, spec.securitySchemes[name]] as const)
    .filter((entry): entry is [string, SecurityScheme] => entry[1] !== undefined);
  if (schemes.length === 0) return "";
  const rows = schemes
    .map(
      ([name, scheme]) =>
        `<div class="rs-auth__row"><code class="rs-schema__key">${esc(
          name,
        )}</code><span class="rs-auth__t">${esc(describeScheme(scheme))}${
          scheme.description ? ` ${esc(scheme.description)}` : ""
        }</span></div>`,
    )
    .join("");
  return `<div class="rs-op__section">${sectionHead("Authentication")}<div class="rs-auth">${rows}</div></div>`;
}

export function describeScheme(scheme: SecurityScheme): string {
  switch (scheme.type) {
    case "apiKey":
      return `API key in ${scheme.in ?? "header"}${scheme.name ? ` (${scheme.name})` : ""}.`;
    case "http":
      return scheme.scheme === "bearer"
        ? `HTTP bearer${scheme.bearerFormat ? ` (${scheme.bearerFormat})` : ""}.`
        : `HTTP ${scheme.scheme ?? "auth"}.`;
    case "oauth2": {
      const flows = scheme.flows ? Object.keys(scheme.flows).join(", ") : "";
      return `OAuth 2.0${flows ? ` (${flows})` : ""}.`;
    }
    case "openIdConnect":
      return "OpenID Connect.";
    default:
      return scheme.type;
  }
}

/** The method + path identity bar with its copy control. */
export function renderOperationBar(op: Operation, spec: NormalizedSpec): string {
  const base = serverBase(spec);
  const path = `<span class="rs-op__path-base">${esc(base)}</span><b>${esc(op.path)}</b>`;
  const copyTarget = `${spec.servers[0]?.url ?? ""}${op.path}`;
  return `<div class="rs-op__id">${verb(op.method)}<span class="rs-op__path">${path}</span><button class="rs-op__copy" type="button" data-rs-copy-text="${esc(
    copyTarget,
  )}" aria-label="Copy request URL">${COPY_ICON}</button></div>`;
}

/** The generated reference sections: parameters, request body, responses, auth. */
export function renderOperationSections(op: Operation, spec: NormalizedSpec): string {
  const ctx: SchemaContext = { schemas: spec.schemas };
  return `${renderParameters(op, ctx)}
${renderRequestBody(op, spec)}
${renderResponses(op, spec)}
${renderAuth(spec, op)}`;
}

/** The left (light) column for one operation. Exported for focused tests. */
export function renderOperation(op: Operation, spec: NormalizedSpec): string {
  const deprecated = op.deprecated
    ? '<div class="rs-op__deprecated" role="note">This operation is deprecated.</div>'
    : "";
  const lede = op.description ? `<p class="rs-op__lede">${esc(op.description)}</p>` : "";
  return `${renderOperationBar(op, spec)}
<h2 class="rs-op__title">${esc(op.summary ?? op.id)}</h2>
${deprecated}${lede}
${renderOperationSections(op, spec)}`;
}

/**
 * Synthesize a representative value from a schema so the console shows a real
 * response body even when the spec carries no explicit example (the common case
 * for reflection-generated specs). Resolves `ref` nodes against the component
 * schemas, drops write-only fields from responses, and bounds cycles and depth.
 */
function synthExample(
  schema: NormalizedSchema | undefined,
  schemas: Record<string, NormalizedSchema>,
  seen: ReadonlySet<string>,
  depth: number,
): unknown {
  if (!schema || depth > 8) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.ref !== undefined) {
    if (seen.has(schema.ref)) return null; // cycle
    const target = schemas[schema.ref];
    if (!target) return null;
    return synthExample(target, schemas, new Set([...seen, schema.ref]), depth + 1);
  }
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  if (schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (prop.writeOnly) continue;
      out[key] = synthExample(prop, schemas, seen, depth + 1);
    }
    return out;
  }
  const type = (schema.type ?? []).find((t) => t !== "null");
  if (type === "array") return [synthExample(schema.items, schemas, seen, depth + 1)];
  if (type === "object") return {};
  if (schema.default !== undefined) return schema.default;
  switch (type) {
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    case "string":
      switch (schema.format) {
        case "date-time":
          return "2026-01-02T15:04:05Z";
        case "date":
          return "2026-01-02";
        case "uuid":
          return "00000000-0000-0000-0000-000000000000";
        case "binary":
          return "<binary>";
        default:
          return "string";
      }
    default:
      return null;
  }
}

function responseExample(response: ApiResponse | undefined, spec: NormalizedSpec): string | null {
  const json = response?.content?.["application/json"];
  if (!json) return null;
  const explicit = json.examples?.[0]?.value ?? json.schema.example;
  const value =
    explicit !== undefined ? explicit : synthExample(json.schema, spec.schemas, new Set(), 0);
  return value === undefined || value === null ? null : JSON.stringify(value, null, 2);
}

/** The right (dark) console for one operation: request samples plus a response readout. */
export function renderOperationConsole(op: Operation, spec: NormalizedSpec): string {
  const base = serverBase(spec);
  const reqline = `<span class="rs-console__reqline"><span class="rs-console__tick">▍</span><span class="rs-console__m">${esc(
    op.method.toUpperCase(),
  )}</span><span class="rs-console__u">${esc(`${base}${op.path}`)}</span></span>`;
  const samples = renderCodeSamples(operationSamples(op, spec.servers[0]?.url ?? ""), reqline);

  const success = op.responses.find((r) => r.status.startsWith("2")) ?? op.responses[0];
  let responseCard = "";
  if (success) {
    const example = responseExample(success, spec);
    const ok = success.status.startsWith("2");
    const body = example
      ? `<figure class="rs-code" data-lang="json"><pre class="shiki"><code>${esc(
          example,
        )}</code></pre></figure>`
      : '<div class="rs-console__empty">No response body.</div>';
    responseCard = `<div class="rs-console__label">Response</div><div class="rs-console__card"><div class="rs-console__status${
      ok ? "" : " is-error"
    }">${HALLMARK_SMALL}<b>${esc(success.status)}</b> ${esc(
      STATUS_TEXT[success.status] ?? "",
    )}</div>${body}</div>`;
  }

  return `<div class="rs-console"><div class="rs-console__label">Request</div><div class="rs-console__card">${samples}</div>${responseCard}</div>`;
}

/** The page-side binding of a data-model page (mirrors mdx PageSchemaApi). */
export interface SchemaPageApi {
  ref: string;
  /** The resolved component-schema name, or null when nothing matched. */
  name: string | null;
}

export interface SchemaPageData {
  title: string;
  /** The authored MDX body, already rendered (may be empty). */
  html: string;
  apiSchema?: SchemaPageApi;
}

/**
 * The content column of a data-model page: title, the schema's description,
 * the authored prose, then the fields via the SchemaViewer. Doc-shaped (no
 * console rail: a model has no request to make). An unresolved name degrades
 * to a danger callout and keeps the prose.
 */
export function renderSchemaMain(
  page: SchemaPageData,
  spec: NormalizedSpec | null | undefined,
): string {
  const name = page.apiSchema?.name;
  const schema = spec && name ? spec.schemas[name] : undefined;
  const prose = page.html.trim()
    ? `<article class="rs-prose rs-op__prose">${page.html}</article>`
    : "";

  if (!spec || !name || !schema) {
    return `<div class="rs-schema-page"><h1 class="rs-op__title">${esc(page.title)}</h1>
<div class="rs-callout rs-callout--danger" role="note"><div class="rs-callout__body"><p class="rs-callout__title">Schema unavailable</p><p>The schema reference <code>${esc(
      page.apiSchema?.ref ?? "",
    )}</code> could not be resolved from the configured OpenAPI spec, so the field reference is missing.</p></div></div>
${prose}</div>`;
  }

  const lede = schema.description ? `<p class="rs-op__lede">${esc(schema.description)}</p>` : "";
  const fields = renderSchema(schema, { schemas: spec.schemas });
  return `<div class="rs-schema-page"><h1 class="rs-op__title">${esc(page.title)}</h1>
${lede}
${prose}
<div class="rs-op__section">${sectionHead("Fields", `<span class="rs-chip">${esc(name)}</span>`)}${fields}</div></div>`;
}

/** The page-side binding a hybrid operation page carries (mirrors mdx PageApi). */
export interface OperationPageApi {
  ref: string;
  operationId: string | null;
  deprecated?: boolean;
  tag?: string;
}

export interface OperationPageData {
  title: string;
  /** The authored MDX body, already rendered (may be empty). */
  html: string;
  api?: OperationPageApi;
}

/**
 * The content column of a hybrid operation page (spec HA-4 order): title,
 * method bar, the operation's own description, the authored prose, then the
 * generated sections, with the assay console as the sticky right rail. An
 * unresolved binding renders a danger callout in place of the generated
 * material and the authored prose still shows: a broken reference must not
 * eat the page.
 */
export function renderOperationMain(
  page: OperationPageData,
  spec: NormalizedSpec | null | undefined,
): string {
  const api = page.api;
  const op =
    spec && api?.operationId ? spec.operations.find((o) => o.id === api.operationId) : undefined;
  const prose = page.html.trim()
    ? `<article class="rs-prose rs-op__prose">${page.html}</article>`
    : "";

  if (!spec || !op) {
    return `<h1 class="rs-op__title">${esc(page.title)}</h1>
<div class="rs-callout rs-callout--danger" role="note"><div class="rs-callout__body"><p class="rs-callout__title">API reference unavailable</p><p>The operation reference <code>${esc(
      api?.ref ?? "",
    )}</code> could not be resolved from the configured OpenAPI spec, so the generated sections are missing.</p></div></div>
${prose}`;
  }

  const deprecated =
    api?.deprecated || op.deprecated
      ? '<div class="rs-op__deprecated" role="note">This operation is deprecated.</div>'
      : "";
  const lede = op.description ? `<p class="rs-op__lede">${esc(op.description)}</p>` : "";
  return `<div class="rs-op__grid"><div class="rs-op__detail"><h1 class="rs-op__title">${esc(
    page.title,
  )}</h1>
${renderOperationBar(op, spec)}
${deprecated}${lede}
${prose}
${renderOperationSections(op, spec)}</div><div class="rs-op__console">${renderOperationConsole(
    op,
    spec,
  )}</div></div>`;
}
