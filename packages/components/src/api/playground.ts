import {
  type HarRequest,
  type HarSource,
  buildHarRequest,
  curlSample,
  fullUrl,
} from "./code-samples.js";
import { jsoncToJson } from "./schema-sample.js";

/**
 * The playground request model. A form's state maps to one canonical HAR (via
 * `buildHarRequest`), and both the copyable curl and the JSON the console POSTs
 * to the proxy derive from it, so they are the same request by construction
 * (spec FR-14). Auth is injected identically to the server-side proxy, so the
 * curl a reader sees matches exactly what "Try It" sends.
 */

export type AuthInput =
  | { kind: "none" }
  | { kind: "apiKey"; in: "header" | "query" | "cookie"; name: string; value: string }
  | { kind: "bearer"; token: string }
  | { kind: "basic"; username: string; password: string };

export interface PlaygroundForm {
  /** The selected server base URL. */
  baseUrl?: string;
  /** Parameter values keyed `${in}:${name}`. */
  params?: Record<string, string>;
  /** The request body text (JSON). */
  body?: string;
  /** Reader-entered credentials (transient; never persisted). */
  auth?: AuthInput;
}

/** The JSON body the console POSTs to `/_readsmith/api/proxy` (the proxy validates it). */
export interface WireRequest {
  method: string;
  url: string;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
  body?: { kind: "raw"; value: string; contentType?: string };
  auth?: AuthInput;
}

function toBase64Utf8(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Apply auth to a HAR the same way the server-side proxy injects it, for display
 * (the curl). Returns a new HAR; the input is not mutated.
 */
function applyAuth(har: HarRequest, auth: AuthInput): HarRequest {
  if (auth.kind === "none") return har;
  const headers = [...har.headers];
  const queryString = [...har.queryString];
  if (auth.kind === "bearer") {
    headers.push({ name: "Authorization", value: `Bearer ${auth.token}` });
  } else if (auth.kind === "basic") {
    headers.push({
      name: "Authorization",
      value: `Basic ${toBase64Utf8(`${auth.username}:${auth.password}`)}`,
    });
  } else if (auth.in === "header") {
    headers.push({ name: auth.name, value: auth.value });
  } else if (auth.in === "query") {
    queryString.push({ name: auth.name, value: auth.value });
  } else {
    headers.push({ name: "Cookie", value: `${auth.name}=${auth.value}` });
  }
  return { ...har, headers, queryString };
}

/** The canonical HAR for a form (shared by the curl and the wire request). */
export function formToHar(op: HarSource, form: PlaygroundForm): HarRequest {
  // The body is authored as JSONC (skeleton comments, trailing commas); normalize
  // it to valid JSON here so the curl, the proxy request, and direct mode are the
  // one identical request and none of them ever carries a comment (spec FR-14).
  const body = form.body === undefined ? undefined : jsoncToJson(form.body);
  return buildHarRequest(op, { baseUrl: form.baseUrl, params: form.params, body });
}

/** The live curl a reader copies, reflecting the current form (params, body, auth). */
export function formToCurl(op: HarSource, form: PlaygroundForm): string {
  return curlSample(applyAuth(formToHar(op, form), form.auth ?? { kind: "none" }));
}

function collectQuery(har: HarRequest): Record<string, string | string[]> | undefined {
  if (har.queryString.length === 0) return undefined;
  const out: Record<string, string | string[]> = {};
  for (const { name, value } of har.queryString) {
    const existing = out[name];
    if (existing === undefined) out[name] = value;
    else out[name] = Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  return out;
}

function collectHeaders(har: HarRequest): Record<string, string> | undefined {
  if (har.headers.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const { name, value } of har.headers) out[name] = value;
  return out;
}

/**
 * The JSON the console sends to the proxy. Auth rides the dedicated `auth` field
 * (the proxy injects it exactly as `applyAuth` renders it for the curl), so the
 * displayed curl and the sent request are the same effective request (FR-14).
 */
export function formToWireRequest(op: HarSource, form: PlaygroundForm): WireRequest {
  const har = formToHar(op, form);
  const req: WireRequest = { method: har.method, url: har.url };
  const query = collectQuery(har);
  if (query) req.query = query;
  const headers = collectHeaders(har);
  if (headers) req.headers = headers;
  if (har.postData) {
    req.body = { kind: "raw", value: har.postData.text, contentType: har.postData.mimeType };
  }
  if (form.auth && form.auth.kind !== "none") req.auth = form.auth;
  return req;
}

/** A concrete browser request for direct mode (auth injected into headers/query, no proxy). */
export interface DirectRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * The request the browser sends directly to the target when the API allows CORS
 * (FR-9): auth is injected here (not by the proxy), so the reader's credential
 * never transits our infrastructure. Same underlying HAR as the curl and the
 * proxy request, so all three are the one request.
 */
export function formToFetch(op: HarSource, form: PlaygroundForm): DirectRequest {
  const har = applyAuth(formToHar(op, form), form.auth ?? { kind: "none" });
  return {
    method: har.method,
    url: fullUrl(har),
    headers: collectHeaders(har) ?? {},
    body: har.postData?.text,
  };
}
