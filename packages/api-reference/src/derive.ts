import type { NormalizedSchema, Operation } from "@readsmith/model";

/**
 * Derived artifacts computed from a normalized operation: the text an endpoint is
 * indexed and searched by, and a canonical HAR request seed. The HAR seed is the
 * one request representation that later drives both code samples and (v1.1)
 * execute, so the curl a reader sees matches what would run.
 */

/** The searchable text for an endpoint (feeds api_endpoints.search_text, later embeddings). */
export function endpointSearchText(op: Operation): string {
  const parts = [op.method.toUpperCase(), op.path];
  if (op.summary) parts.push(op.summary);
  if (op.description) parts.push(op.description);
  parts.push(...op.tags);
  return parts.join(" ").trim();
}

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
 * A minimal, deterministic HAR request seed for an operation. Path parameters are
 * substituted with their example or a `{name}` placeholder; query and header
 * params become HAR entries. Slice-4 code-sample generation consumes this.
 */
export function buildHarRequest(op: Operation, baseUrl = ""): HarRequest {
  let path = op.path;
  const queryString: HarNameValue[] = [];
  const headers: HarNameValue[] = [];

  for (const param of op.parameters) {
    const value = exampleString(param.example ?? param.schema.example ?? param.schema.default);
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
    request.postData = { mimeType: "application/json", text: sampleBody(json.schema) };
  }
  return request;
}

function exampleString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** A tiny deterministic body from the first example, or an empty object. */
function sampleBody(schema: NormalizedSchema): string {
  if (schema.example !== undefined) return JSON.stringify(schema.example, null, 2);
  return "{}";
}
