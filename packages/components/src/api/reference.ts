import type {
  ApiResponse,
  NormalizedSchema,
  NormalizedSpec,
  Operation,
  Parameter,
  SecurityScheme,
} from "@readsmith/model";
import { header, palette } from "../shell/layout.js";
import type { ShellSite } from "../shell/layout.js";
import { esc } from "../shell/util.js";
import { operationSamples, renderCodeSamples } from "./code-samples.js";
import { type SchemaContext, renderSchema } from "./schema-viewer.js";

/**
 * The read-only API reference: one continuous page. A front-door overview, then
 * every operation as a section with its detail on the left (schemas rendered by
 * the SchemaViewer) and its own dark "assay console" on the right (code samples
 * plus a response readout). SSR HTML strings; the only interactive parts are the
 * shared Tabs/CodeGroup islands and a scroll-spy that tracks the nav. Each
 * operation is deep-linkable by its id anchor.
 */

export interface ReferenceOptions {
  /** URL prefix the reference is mounted at (for cross-page deep links). */
  basePath?: string;
}

const DEFAULT_BASE = "/api-reference";

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

/** The stable, deep-linkable URL path for an operation (cross-page). */
export function operationPath(op: Operation, options: ReferenceOptions = {}): string {
  return `${options.basePath ?? DEFAULT_BASE}/${op.id}`;
}

/** The in-page anchor for an operation. */
export function operationAnchor(op: Operation): string {
  return `#${op.id}`;
}

/** Operations grouped by their first tag, tags ordered per the spec then alphabetically. */
export function referenceGroups(spec: NormalizedSpec): { tag: string; operations: Operation[] }[] {
  const order = spec.tags.map((t) => t.name);
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

/** A tag section header in the flow, mirroring the nav's grouping. */
function renderGroupHeader(tag: string, spec: NormalizedSpec): string {
  const description = spec.tags.find((t) => t.name === tag)?.description;
  return `<div class="rs-apigroup"><h2 class="rs-apigroup__title">${esc(tag)}</h2>${
    description ? `<p class="rs-apigroup__desc">${esc(description)}</p>` : ""
  }</div>`;
}

function serverBase(spec: NormalizedSpec): string {
  const url = spec.servers[0]?.url;
  if (!url) return "";
  try {
    return new URL(url).pathname.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function verb(method: string, small = false): string {
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

/** The tag-grouped operation navigation (left panel), linking to in-page anchors. */
export function renderApiNav(
  spec: NormalizedSpec,
  activeId?: string,
  _options: ReferenceOptions = {},
): string {
  const groups = referenceGroups(spec)
    .map((group) => {
      const links = group.operations
        .map((op) => {
          const active = op.id === activeId ? " is-active" : "";
          const dep = op.deprecated ? " is-deprecated" : "";
          const aria = op.id === activeId ? ' aria-current="true"' : "";
          return `<a class="rs-apinav__link rs-nav__link${active}${dep}" href="${operationAnchor(
            op,
          )}"${aria}>${verb(op.method, true)}<span class="rs-apinav__label">${esc(
            op.summary ?? op.path,
          )}</span></a>`;
        })
        .join("");
      return `<div class="rs-apinav__group"><div class="rs-apinav__tag rs-eyebrow">${esc(
        group.tag,
      )}</div>${links}</div>`;
    })
    .join("");
  return `<nav class="rs-apinav" aria-label="API reference">${groups}</nav>`;
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
    .map(([mediaType, media]) => renderSchema(media.schema, ctx))
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

function describeScheme(scheme: SecurityScheme): string {
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

/** The left (light) column for one operation. Exported for focused tests. */
export function renderOperation(op: Operation, spec: NormalizedSpec): string {
  const ctx: SchemaContext = { schemas: spec.schemas };
  const base = serverBase(spec);
  const path = `<span class="rs-op__path-base">${esc(base)}</span><b>${esc(op.path)}</b>`;
  const copyTarget = `${spec.servers[0]?.url ?? ""}${op.path}`;
  const deprecated = op.deprecated
    ? '<div class="rs-op__deprecated" role="note">This operation is deprecated.</div>'
    : "";
  const lede = op.description ? `<p class="rs-op__lede">${esc(op.description)}</p>` : "";
  return `<div class="rs-op__id">${verb(op.method)}<span class="rs-op__path">${path}</span><button class="rs-op__copy" type="button" data-rs-copy-text="${esc(
    copyTarget,
  )}" aria-label="Copy request URL">${COPY_ICON}</button></div>
<h2 class="rs-op__title">${esc(op.summary ?? op.id)}</h2>
${deprecated}${lede}
${renderParameters(op, ctx)}
${renderRequestBody(op, spec)}
${renderResponses(op, spec)}
${renderAuth(spec, op)}`;
}

function responseExample(response: ApiResponse | undefined): string | null {
  const json = response?.content?.["application/json"];
  if (!json) return null;
  const value = json.examples?.[0]?.value ?? json.schema.example;
  return value !== undefined ? JSON.stringify(value, null, 2) : null;
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
    const example = responseExample(success);
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

/** One operation section: detail plus console, deep-linkable by anchor. */
function renderOperationSection(op: Operation, spec: NormalizedSpec): string {
  return `<section class="rs-op" id="${esc(op.id)}"><div class="rs-op__grid"><div class="rs-op__detail">${renderOperation(
    op,
    spec,
  )}</div><div class="rs-op__console">${renderOperationConsole(op, spec)}</div></div></section>`;
}

/** The front-door overview: title, base URL, version, auth summary. */
function renderApiIntro(spec: NormalizedSpec): string {
  const info = spec.info;
  const chips: string[] = [];
  const server = spec.servers[0]?.url;
  if (server) chips.push(metachip("Base URL", server));
  chips.push(metachip("Version", info.version));
  const authNames = Object.keys(spec.securitySchemes);
  if (authNames.length > 0) {
    const first = spec.securitySchemes[authNames[0] ?? ""];
    if (first) chips.push(metachip("Auth", describeScheme(first).replace(/\.$/, "")));
  }
  return `<section class="rs-apiintro"><h1 class="rs-apiintro__title">${esc(info.title)}</h1>${
    info.description ? `<p class="rs-apiintro__lede">${esc(info.description)}</p>` : ""
  }<div class="rs-apiintro__meta">${chips.join("")}</div></section>`;
}

function metachip(label: string, value: string): string {
  return `<span class="rs-metachip">${esc(label)} <b>${esc(value)}</b></span>`;
}

/** The full reference body: chrome, nav, and every operation on one page. */
export function renderReferenceBody(
  site: ShellSite,
  spec: NormalizedSpec,
  options: ReferenceOptions = {},
): string {
  const sections = referenceGroups(spec)
    .map((group) => {
      const header = renderGroupHeader(group.tag, spec);
      const ops = group.operations.map((op) => renderOperationSection(op, spec)).join("");
      return `${header}${ops}`;
    })
    .join("");
  return `<a class="rs-skip" href="#rs-content">Skip to content</a>
${header(site)}
<div class="rs-scrim" data-rs-scrim hidden></div>
<div class="rs-apiref" data-rs-apiref>
  <div class="rs-apinav-col" data-rs-navcol>${renderApiNav(spec, undefined, options)}</div>
  <main class="rs-apiref__main" id="rs-content" tabindex="-1">
    ${renderApiIntro(spec)}
    ${sections}
  </main>
</div>
${palette(site)}`;
}
