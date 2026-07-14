import type { CodeSample, NormalizedSchema, Operation } from "@readsmith/model";
import { esc } from "../shell/util.js";

/**
 * Static, deterministic code samples for an operation, built from one canonical
 * HAR request seed so the curl a reader copies is the same request every language
 * expresses (and, later, the same the playground would send). Authored
 * `x-codeSamples` take precedence for their language; generated samples fill the
 * rest. Rendered through the CodeGroup island, so the chosen language persists
 * across every operation on the page.
 */

export interface HarNameValue {
  name: string;
  value: string;
}
export interface HarRequest {
  method: string;
  url: string;
  headers: HarNameValue[];
  queryString: HarNameValue[];
  postData?: { mimeType: string; text: string };
}

/**
 * The minimal operation shape `buildHarRequest` reads. A full `Operation`
 * satisfies it structurally, and so does the trimmed seed the playground island
 * embeds (so the browser rebuilds the same request without the whole spec).
 */
export interface HarSource {
  method: string;
  path: string;
  parameters: {
    name: string;
    in: "path" | "query" | "header" | "cookie";
    example?: unknown;
    schema: { example?: unknown; default?: unknown };
  }[];
  requestBody?: { content: Record<string, { schema: { example?: unknown } }> };
}

/** Reader-supplied overrides from the playground form; each falls back to the example. */
export interface RequestOverrides {
  /** The selected server base URL. */
  baseUrl?: string;
  /** Parameter values keyed `${in}:${name}` (e.g. `path:id`, `query:page`). */
  params?: Record<string, string>;
  /** The request body text (JSON). */
  body?: string;
}

/**
 * The canonical HAR request seed for an operation. With no overrides it is the
 * example-filled static sample; with a playground form's overrides it is exactly
 * what "Try It" would send. One function, so the copyable curl and the sent
 * request are the same shape by construction (spec FR-14).
 */
export function buildHarRequest(op: HarSource, overrides: RequestOverrides = {}): HarRequest {
  const baseUrl = overrides.baseUrl ?? "";
  let path = op.path;
  const queryString: HarNameValue[] = [];
  const headers: HarNameValue[] = [];

  for (const param of op.parameters) {
    const override = overrides.params?.[`${param.in}:${param.name}`];
    const value =
      override !== undefined && override !== ""
        ? override
        : exampleString(param.example ?? param.schema.example ?? param.schema.default);
    if (param.in === "path") {
      path = path.replace(`{${param.name}}`, value || `{${param.name}}`);
    } else if (param.in === "query") {
      queryString.push({ name: param.name, value });
    } else if (param.in === "header") {
      headers.push({ name: param.name, value });
    }
  }

  const request: HarRequest = {
    method: op.method.toUpperCase(),
    url: `${baseUrl.replace(/\/+$/, "")}${path}`,
    headers,
    queryString,
  };

  const json = op.requestBody?.content["application/json"];
  if (json) {
    headers.push({ name: "Content-Type", value: "application/json" });
    request.postData = {
      mimeType: "application/json",
      text: overrides.body ?? sampleBody(json.schema),
    };
  }
  return request;
}

interface Generator {
  lang: string;
  label: string;
  generate: (har: HarRequest) => string;
}

const GENERATORS: Generator[] = [
  { lang: "curl", label: "cURL", generate: curlSample },
  { lang: "javascript", label: "JavaScript", generate: jsSample },
  { lang: "python", label: "Python", generate: pythonSample },
];

/**
 * The samples for an operation: generated for the default languages, overlaid by
 * authored `x-codeSamples` (which replace a generated language or add a new one).
 */
export function operationSamples(op: Operation, baseUrl: string): CodeSample[] {
  const har = buildHarRequest(op, { baseUrl });
  const byLang = new Map<string, CodeSample>();
  for (const gen of GENERATORS) {
    byLang.set(gen.lang, { lang: gen.lang, label: gen.label, source: gen.generate(har) });
  }
  for (const authored of op.codeSamples ?? []) {
    byLang.set(authored.lang, authored);
  }
  return [...byLang.values()];
}

export function fullUrl(har: HarRequest): string {
  if (har.queryString.length === 0) return har.url;
  const query = har.queryString
    .map((q) => `${encodeURIComponent(q.name)}=${encodeURIComponent(q.value)}`)
    .join("&");
  return `${har.url}?${query}`;
}

export function curlSample(har: HarRequest): string {
  const lines = [`curl ${quote(fullUrl(har))}`];
  if (har.method !== "GET") lines.push(`  -X ${har.method}`);
  for (const header of har.headers) lines.push(`  -H ${quote(`${header.name}: ${header.value}`)}`);
  if (har.postData) lines.push(`  -d ${quote(har.postData.text)}`);
  return lines.join(" \\\n");
}

function jsSample(har: HarRequest): string {
  const options: string[] = [`  method: ${JSON.stringify(har.method)},`];
  if (har.headers.length > 0) {
    const entries = har.headers.map(
      (h) => `    ${JSON.stringify(h.name)}: ${JSON.stringify(h.value)},`,
    );
    options.push(`  headers: {\n${entries.join("\n")}\n  },`);
  }
  if (har.postData) options.push(`  body: ${JSON.stringify(har.postData.text)},`);
  return `const response = await fetch(${JSON.stringify(fullUrl(har))}, {\n${options.join(
    "\n",
  )}\n});\nconst data = await response.json();`;
}

function pythonSample(har: HarRequest): string {
  const args: string[] = [JSON.stringify(fullUrl(har))];
  if (har.headers.length > 0) {
    const entries = har.headers.map(
      (h) => `    ${JSON.stringify(h.name)}: ${JSON.stringify(h.value)},`,
    );
    args.push(`headers={\n${entries.join("\n")}\n}`);
  }
  if (har.postData) args.push(`data=${JSON.stringify(har.postData.text)}`);
  const method = har.method.toLowerCase();
  return `import requests\n\nresponse = requests.${method}(\n    ${args.join(
    ",\n    ",
  )},\n)\ndata = response.json()`;
}

/** Render the samples as a CodeGroup island (tabbed, page-wide language sync).
 * An optional `reqline` (already-escaped HTML) is placed at the start of the tab
 * bar, used by the console to show the request method and path. */
export function renderCodeSamples(samples: CodeSample[], reqline = ""): string {
  if (samples.length === 0) return "";
  const tabs = samples
    .map(
      (s, i) =>
        `<button class="rs-codegroup__tab" type="button" role="tab" data-rs-tab-title="${esc(
          s.label,
        )}" aria-selected="${i === 0 ? "true" : "false"}" tabindex="${i === 0 ? 0 : -1}">${esc(
          s.label,
        )}</button>`,
    )
    .join("");
  const panels = samples
    .map(
      (s, i) =>
        `<figure class="rs-code" data-lang="${esc(s.lang)}" role="tabpanel"${
          i === 0 ? "" : " hidden"
        }><figcaption class="rs-code__bar"><span class="rs-code__lang">${esc(
          s.label,
        )}</span></figcaption><pre class="shiki" tabindex="0"><code>${esc(s.source)}</code></pre></figure>`,
    )
    .join("");
  return `<div class="rs-codegroup" data-rs-group="rs-api-lang" data-island="CodeGroup"><div class="rs-codegroup__list" role="tablist">${reqline}${tabs}</div><div class="rs-codegroup__panels">${panels}</div></div>`;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function exampleString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function sampleBody(schema: NormalizedSchema): string {
  if (schema.example !== undefined) return JSON.stringify(schema.example, null, 2);
  return "{}";
}
