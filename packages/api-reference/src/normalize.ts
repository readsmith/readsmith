import type {
  ApiResponse,
  CodeSample,
  Diagnostic,
  Discriminator,
  Info,
  MediaType,
  NamedExample,
  NormalizedSchema,
  Operation,
  Parameter,
  SchemaConflict,
  SchemaType,
  SecurityRequirement,
  SecurityScheme,
  Server,
  Tag,
} from "@readsmith/model";
import { contentHash } from "@readsmith/model";

/**
 * Normalize a bundled OpenAPI document (internal `$ref`s only) into the semantic
 * content of a NormalizedSpec. This is the module that gives consumers one shape:
 * allOf is merged, oneOf/anyOf become tagged variants, discriminators resolve,
 * nullability folds into the type list, and cycles are broken with `ref` nodes
 * marked `cyclic` (never infinitely expanded). Pure: no IO, deterministic.
 */

export interface NormalizedContent {
  info: Info;
  servers: Server[];
  securitySchemes: Record<string, SecurityScheme>;
  tags: Tag[];
  operations: Operation[];
  schemas: Record<string, NormalizedSchema>;
  diagnostics: Diagnostic[];
}

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const VALID_TYPES = new Set<SchemaType>([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);
const MAX_DEPTH = 100;

/** Stable operation id: the authored operationId, or a hash of method+path. */
export function stableOperationId(method: string, path: string): string {
  return contentHash(`${method.toLowerCase()} ${path}`).slice(0, 16);
}

export function normalizeDocument(doc: unknown, source: string): NormalizedContent {
  const root = asObj(doc) ?? {};
  const componentsRaw = asObj(asObj(root.components)?.schemas) ?? {};
  const parametersRaw = asObj(asObj(root.components)?.parameters) ?? {};
  const schemas: Record<string, NormalizedSchema> = {};
  const active = new Set<string>();
  const diagnostics: Diagnostic[] = [];

  const diag = (code: string, message: string): void => {
    diagnostics.push({ severity: "warning", code, message, source });
  };

  function ensureComponent(name: string): void {
    if (name in schemas || active.has(name)) return;
    const raw = asObj(componentsRaw[name]);
    if (!raw) {
      diag("unresolved-ref", `Schema component "${name}" is not defined.`);
      schemas[name] = {};
      return;
    }
    active.add(name);
    const normalized = normalizeInline(raw, 0);
    active.delete(name);
    schemas[name] = normalized;
  }

  function normalizeSchema(raw: unknown, depth: number): NormalizedSchema {
    const o = asObj(raw);
    if (!o) return {};
    const ref = asStr(o.$ref);
    if (ref !== undefined) {
      const name = schemaRefName(ref);
      if (name === null) {
        diag("unresolved-ref", `Cannot resolve schema reference "${ref}".`);
        return {};
      }
      const cyclic = active.has(name);
      if (!cyclic) ensureComponent(name);
      return cyclic ? { ref: name, cyclic: true } : { ref: name };
    }
    return normalizeInline(o, depth);
  }

  function normalizeInline(o: Record<string, unknown>, depth: number): NormalizedSchema {
    if (depth > MAX_DEPTH) {
      diag("max-depth", "Schema nesting exceeded the depth budget; truncated.");
      return {};
    }

    // allOf: merge into a flat object, then normalize the result.
    const allOf = asArr(o.allOf);
    if (allOf) {
      const base: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(o)) if (key !== "allOf") base[key] = value;
      const { merged, conflicts } = mergeAllOf(base, allOf, depth);
      const result = normalizeInline(merged, depth + 1);
      if (conflicts.length > 0) result.conflicts = conflicts;
      return result;
    }

    const out: NormalizedSchema = {};

    // oneOf / anyOf: tagged variant selectors.
    const oneOf = asArr(o.oneOf);
    const anyOf = asArr(o.anyOf);
    if (oneOf || anyOf) {
      const kind = oneOf ? "oneOf" : "anyOf";
      const variantsRaw = oneOf ?? anyOf ?? [];
      const variants = variantsRaw.map((v) => normalizeSchema(v, depth + 1));
      out.composition = { kind, variants };
      const disc = normalizeDiscriminator(asObj(o.discriminator));
      if (disc) out.composition.discriminator = disc;
    }

    const types = normalizeTypes(o, diag);
    if (types) out.type = types;

    copyStr(o, "format", out, "format");
    copyStr(o, "title", out, "title");
    copyStr(o, "description", out, "description");
    copyStr(o, "pattern", out, "pattern");
    copyBool(o, "deprecated", out, "deprecated");
    copyBool(o, "readOnly", out, "readOnly");
    copyBool(o, "writeOnly", out, "writeOnly");
    copyBool(o, "uniqueItems", out, "uniqueItems");
    copyNum(o, "minLength", out, "minLength");
    copyNum(o, "maxLength", out, "maxLength");
    copyNum(o, "multipleOf", out, "multipleOf");
    copyNum(o, "minItems", out, "minItems");
    copyNum(o, "maxItems", out, "maxItems");
    copyNum(o, "minProperties", out, "minProperties");
    copyNum(o, "maxProperties", out, "maxProperties");
    applyNumericBounds(o, out);

    if ("enum" in o) out.enum = asArr(o.enum) ?? [];
    if ("const" in o) out.const = o.const;
    if ("default" in o) out.default = o.default;
    if ("example" in o) out.example = o.example;
    if ("examples" in o && Array.isArray(o.examples)) out.examples = o.examples;

    const props = asObj(o.properties);
    if (props) {
      out.properties = {};
      for (const [key, value] of Object.entries(props)) {
        out.properties[key] = normalizeSchema(value, depth + 1);
      }
    }
    const required = asArr(o.required);
    if (required) out.required = required.filter((x): x is string => typeof x === "string");

    if ("items" in o) {
      const items = o.items;
      out.items = normalizeSchema(Array.isArray(items) ? items[0] : items, depth + 1);
    }
    if ("additionalProperties" in o) {
      const ap = o.additionalProperties;
      out.additionalProperties = typeof ap === "boolean" ? ap : normalizeSchema(ap, depth + 1);
    }

    return out;
  }

  function mergeAllOf(
    base: Record<string, unknown>,
    members: unknown[],
    depth: number,
  ): { merged: Record<string, unknown>; conflicts: SchemaConflict[] } {
    const merged: Record<string, unknown> = {};
    const properties: Record<string, unknown> = {};
    const required = new Set<string>();
    const typeSet = new Set<string>();
    const conflicts: SchemaConflict[] = [];

    for (const member of [base, ...members]) {
      const r = resolveRawForMerge(member);
      const t = r.type;
      if (typeof t === "string") typeSet.add(t);
      else if (Array.isArray(t)) for (const x of t) if (typeof x === "string") typeSet.add(x);
      const p = asObj(r.properties);
      if (p) Object.assign(properties, p);
      const req = asArr(r.required);
      if (req) for (const x of req) if (typeof x === "string") required.add(x);
      for (const [key, value] of Object.entries(r)) {
        if (key === "properties" || key === "required" || key === "type" || key === "allOf")
          continue;
        if (!(key in merged)) merged[key] = value;
      }
    }

    const nonNull = [...typeSet].filter((t) => t !== "null");
    if (nonNull.length > 1) {
      conflicts.push({
        keyword: "type",
        message: `allOf combines incompatible types: ${nonNull.join(", ")}.`,
      });
    }
    if (typeSet.size > 0) merged.type = [...typeSet];
    if (Object.keys(properties).length > 0) merged.properties = properties;
    if (required.size > 0) merged.required = [...required];

    const min = asNum(merged.minimum);
    const max = asNum(merged.maximum);
    if (min !== undefined && max !== undefined && min > max) {
      conflicts.push({ keyword: "maximum", message: `minimum ${min} exceeds maximum ${max}.` });
    }
    return { merged, conflicts };
  }

  function resolveRawForMerge(raw: unknown): Record<string, unknown> {
    const o = asObj(raw);
    if (!o) return {};
    const ref = asStr(o.$ref);
    if (ref !== undefined) {
      const name = schemaRefName(ref);
      return (name !== null ? asObj(componentsRaw[name]) : undefined) ?? {};
    }
    return o;
  }

  function normalizeParam(raw: unknown): Parameter | null {
    let o = asObj(raw);
    if (!o) return null;
    const ref = asStr(o.$ref);
    if (ref !== undefined) {
      const name = paramRefName(ref);
      o = (name !== null ? asObj(parametersRaw[name]) : undefined) ?? undefined;
      if (!o) return null;
    }
    const name = asStr(o.name);
    const location = asStr(o.in);
    if (!name || !isParamLocation(location)) return null;
    const param: Parameter = {
      name,
      in: location,
      required: location === "path" ? true : o.required === true,
      schema: normalizeSchema(o.schema ?? {}, 0),
    };
    const description = asStr(o.description);
    if (description !== undefined) param.description = description;
    if (o.deprecated === true) param.deprecated = true;
    if ("example" in o) param.example = o.example;
    return param;
  }

  function normalizeContent(raw: unknown): Record<string, MediaType> {
    const content = asObj(raw);
    if (!content) return {};
    const out: Record<string, MediaType> = {};
    for (const [mediaType, value] of Object.entries(content)) {
      const mt = asObj(value) ?? {};
      const entry: MediaType = { schema: normalizeSchema(mt.schema ?? {}, 0) };
      const examples = normalizeExamples(mt.examples);
      if (examples.length > 0) entry.examples = examples;
      out[mediaType] = entry;
    }
    return out;
  }

  function normalizeOperations(): Operation[] {
    const paths = asObj(root.paths) ?? {};
    const operations: Operation[] = [];
    for (const [path, pathItemRaw] of Object.entries(paths)) {
      const pathItem = asObj(pathItemRaw);
      if (!pathItem) continue;
      const sharedParams = (asArr(pathItem.parameters) ?? [])
        .map(normalizeParam)
        .filter((p): p is Parameter => p !== null);

      for (const method of HTTP_METHODS) {
        const opRaw = asObj(pathItem[method]);
        if (!opRaw) continue;

        const ownParams = (asArr(opRaw.parameters) ?? [])
          .map(normalizeParam)
          .filter((p): p is Parameter => p !== null);
        const parameters = mergeParams(sharedParams, ownParams);

        const operationId = asStr(opRaw.operationId);
        const operation: Operation = {
          id: operationId ?? stableOperationId(method, path),
          method,
          path,
          deprecated: opRaw.deprecated === true,
          tags: (asArr(opRaw.tags) ?? []).filter((t): t is string => typeof t === "string"),
          parameters,
          responses: normalizeResponses(opRaw.responses),
        };
        const summary = asStr(opRaw.summary);
        if (summary !== undefined) operation.summary = summary;
        const description = asStr(opRaw.description);
        if (description !== undefined) operation.description = description;

        const bodyRaw = asObj(opRaw.requestBody);
        if (bodyRaw) {
          operation.requestBody = {
            required: bodyRaw.required === true,
            content: normalizeContent(bodyRaw.content),
          };
          const bodyDesc = asStr(bodyRaw.description);
          if (bodyDesc !== undefined) operation.requestBody.description = bodyDesc;
        }

        const security = normalizeSecurityRequirements(opRaw.security);
        if (security) operation.security = security;

        const samples = normalizeCodeSamples(opRaw["x-codeSamples"] ?? opRaw["x-code-samples"]);
        if (samples.length > 0) operation.codeSamples = samples;

        operations.push(operation);
      }
    }
    return operations;
  }

  function normalizeResponses(raw: unknown): ApiResponse[] {
    const responses = asObj(raw);
    if (!responses) return [];
    const out: ApiResponse[] = [];
    for (const [status, value] of Object.entries(responses)) {
      const r = asObj(value) ?? {};
      const response: ApiResponse = { status };
      const description = asStr(r.description);
      if (description !== undefined) response.description = description;
      const content = normalizeContent(r.content);
      if (Object.keys(content).length > 0) response.content = content;
      out.push(response);
    }
    return out.sort((a, b) => a.status.localeCompare(b.status));
  }

  // Assemble the document.
  const infoRaw = asObj(root.info) ?? {};
  const info: Info = {
    title: asStr(infoRaw.title) ?? "API",
    version: asStr(infoRaw.version) ?? "0.0.0",
  };
  const infoDesc = asStr(infoRaw.description);
  if (infoDesc !== undefined) info.description = infoDesc;

  const operations = normalizeOperations();
  // Normalize any remaining components not reached through operations, so the
  // schemas map is complete for the renderer.
  for (const name of Object.keys(componentsRaw)) ensureComponent(name);

  return {
    info,
    servers: normalizeServers(root.servers),
    securitySchemes: normalizeSecuritySchemes(asObj(root.components)?.securitySchemes),
    tags: normalizeTags(root.tags),
    operations,
    schemas,
    diagnostics,
  };
}

// --- pure helpers (no closure state) ---

function normalizeTypes(
  o: Record<string, unknown>,
  diag: (code: string, message: string) => void,
): SchemaType[] | undefined {
  const raw = o.type;
  const collected: string[] = [];
  if (typeof raw === "string") collected.push(raw);
  else if (Array.isArray(raw)) for (const x of raw) if (typeof x === "string") collected.push(x);
  if (o.nullable === true && !collected.includes("null")) collected.push("null");

  const valid = collected.filter((t): t is SchemaType => VALID_TYPES.has(t as SchemaType));
  if (valid.length !== collected.length) {
    diag("invalid-type", `Ignored unknown schema type(s): ${collected.join(", ")}.`);
  }
  return valid.length > 0 ? valid : undefined;
}

function applyNumericBounds(o: Record<string, unknown>, out: NormalizedSchema): void {
  const min = asNum(o.minimum);
  const max = asNum(o.maximum);
  const exMin = o.exclusiveMinimum;
  const exMax = o.exclusiveMaximum;
  if (min !== undefined && exMin !== true) out.minimum = min;
  if (max !== undefined && exMax !== true) out.maximum = max;
  if (typeof exMin === "number") out.exclusiveMinimum = exMin;
  else if (exMin === true && min !== undefined) out.exclusiveMinimum = min;
  if (typeof exMax === "number") out.exclusiveMaximum = exMax;
  else if (exMax === true && max !== undefined) out.exclusiveMaximum = max;
}

function normalizeDiscriminator(disc: Record<string, unknown> | undefined): Discriminator | null {
  if (!disc) return null;
  const propertyName = asStr(disc.propertyName);
  if (!propertyName) return null;
  const mapping: Record<string, string> = {};
  const mappingRaw = asObj(disc.mapping);
  if (mappingRaw) {
    for (const [key, value] of Object.entries(mappingRaw)) {
      if (typeof value === "string") mapping[key] = schemaRefName(value) ?? value;
    }
  }
  return { propertyName, mapping };
}

function normalizeExamples(raw: unknown): NamedExample[] {
  const examples = asObj(raw);
  if (!examples) return [];
  const out: NamedExample[] = [];
  for (const [name, value] of Object.entries(examples)) {
    const e = asObj(value) ?? {};
    const example: NamedExample = { name, value: "value" in e ? e.value : undefined };
    const summary = asStr(e.summary);
    if (summary !== undefined) example.summary = summary;
    const description = asStr(e.description);
    if (description !== undefined) example.description = description;
    out.push(example);
  }
  return out;
}

function normalizeCodeSamples(raw: unknown): CodeSample[] {
  const arr = asArr(raw);
  if (!arr) return [];
  const out: CodeSample[] = [];
  for (const value of arr) {
    const s = asObj(value);
    const lang = asStr(s?.lang);
    const source = asStr(s?.source);
    if (!lang || source === undefined) continue;
    out.push({ lang, label: asStr(s?.label) ?? lang, source });
  }
  return out;
}

function normalizeSecuritySchemes(raw: unknown): Record<string, SecurityScheme> {
  const schemes = asObj(raw);
  if (!schemes) return {};
  const out: Record<string, SecurityScheme> = {};
  for (const [name, value] of Object.entries(schemes)) {
    const s = asObj(value);
    const type = asStr(s?.type);
    if (!s || !isSecurityType(type)) continue;
    const scheme: SecurityScheme = { type };
    copyStr(s, "description", scheme, "description");
    copyStr(s, "name", scheme, "name");
    copyStr(s, "scheme", scheme, "scheme");
    copyStr(s, "bearerFormat", scheme, "bearerFormat");
    copyStr(s, "openIdConnectUrl", scheme, "openIdConnectUrl");
    const location = asStr(s.in);
    if (location === "query" || location === "header" || location === "cookie")
      scheme.in = location;
    const flows = asObj(s.flows);
    if (flows) scheme.flows = normalizeFlows(flows);
    out[name] = scheme;
  }
  return out;
}

function normalizeFlows(flows: Record<string, unknown>): Record<
  string,
  {
    authorizationUrl?: string;
    tokenUrl?: string;
    refreshUrl?: string;
    scopes: Record<string, string>;
  }
> {
  const out: Record<
    string,
    {
      authorizationUrl?: string;
      tokenUrl?: string;
      refreshUrl?: string;
      scopes: Record<string, string>;
    }
  > = {};
  for (const [name, value] of Object.entries(flows)) {
    const f = asObj(value);
    if (!f) continue;
    const scopes: Record<string, string> = {};
    const scopesRaw = asObj(f.scopes);
    if (scopesRaw) {
      for (const [k, v] of Object.entries(scopesRaw)) if (typeof v === "string") scopes[k] = v;
    }
    const flow: {
      authorizationUrl?: string;
      tokenUrl?: string;
      refreshUrl?: string;
      scopes: Record<string, string>;
    } = { scopes };
    const authorizationUrl = asStr(f.authorizationUrl);
    if (authorizationUrl !== undefined) flow.authorizationUrl = authorizationUrl;
    const tokenUrl = asStr(f.tokenUrl);
    if (tokenUrl !== undefined) flow.tokenUrl = tokenUrl;
    const refreshUrl = asStr(f.refreshUrl);
    if (refreshUrl !== undefined) flow.refreshUrl = refreshUrl;
    out[name] = flow;
  }
  return out;
}

function normalizeSecurityRequirements(raw: unknown): SecurityRequirement[] | undefined {
  const arr = asArr(raw);
  if (!arr) return undefined;
  const out: SecurityRequirement[] = [];
  for (const value of arr) {
    const o = asObj(value);
    if (!o) continue;
    const requirement: SecurityRequirement = {};
    for (const [name, scopes] of Object.entries(o)) {
      requirement[name] = Array.isArray(scopes)
        ? scopes.filter((s): s is string => typeof s === "string")
        : [];
    }
    out.push(requirement);
  }
  return out;
}

function normalizeServers(raw: unknown): Server[] {
  const arr = asArr(raw);
  if (!arr) return [];
  const out: Server[] = [];
  for (const value of arr) {
    const s = asObj(value);
    const url = asStr(s?.url);
    if (!s || url === undefined) continue;
    const server: Server = { url };
    const description = asStr(s.description);
    if (description !== undefined) server.description = description;
    const variablesRaw = asObj(s.variables);
    if (variablesRaw) {
      const variables: Record<string, { default: string; enum?: string[]; description?: string }> =
        {};
      for (const [name, value2] of Object.entries(variablesRaw)) {
        const v = asObj(value2);
        const def = asStr(v?.default);
        if (!v || def === undefined) continue;
        const variable: { default: string; enum?: string[]; description?: string } = {
          default: def,
        };
        const enumArr = asArr(v.enum);
        if (enumArr) variable.enum = enumArr.filter((e): e is string => typeof e === "string");
        const varDesc = asStr(v.description);
        if (varDesc !== undefined) variable.description = varDesc;
        variables[name] = variable;
      }
      server.variables = variables;
    }
    out.push(server);
  }
  return out;
}

function normalizeTags(raw: unknown): Tag[] {
  const arr = asArr(raw);
  if (!arr) return [];
  const out: Tag[] = [];
  for (const value of arr) {
    const t = asObj(value);
    const name = asStr(t?.name);
    if (!t || name === undefined) continue;
    const tag: Tag = { name };
    const description = asStr(t.description);
    if (description !== undefined) tag.description = description;
    out.push(tag);
  }
  return out;
}

function mergeParams(shared: Parameter[], own: Parameter[]): Parameter[] {
  const byKey = new Map<string, Parameter>();
  for (const p of shared) byKey.set(`${p.in}:${p.name}`, p);
  for (const p of own) byKey.set(`${p.in}:${p.name}`, p);
  return [...byKey.values()];
}

function schemaRefName(ref: string): string | null {
  const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}
function paramRefName(ref: string): string | null {
  const match = /^#\/components\/parameters\/(.+)$/.exec(ref);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function isParamLocation(v: string | undefined): v is Parameter["in"] {
  return v === "path" || v === "query" || v === "header" || v === "cookie";
}
function isSecurityType(v: string | undefined): v is SecurityScheme["type"] {
  return (
    v === "apiKey" || v === "http" || v === "oauth2" || v === "openIdConnect" || v === "mutualTLS"
  );
}

function asObj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
function asArr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}
function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNum(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function copyStr<K extends string>(
  src: Record<string, unknown>,
  key: string,
  dst: Partial<Record<K, unknown>>,
  dstKey: K,
): void {
  const v = asStr(src[key]);
  if (v !== undefined) dst[dstKey] = v;
}
function copyBool<K extends string>(
  src: Record<string, unknown>,
  key: string,
  dst: Partial<Record<K, unknown>>,
  dstKey: K,
): void {
  if (src[key] === true) dst[dstKey] = true;
}
function copyNum<K extends string>(
  src: Record<string, unknown>,
  key: string,
  dst: Partial<Record<K, unknown>>,
  dstKey: K,
): void {
  const v = asNum(src[key]);
  if (v !== undefined) dst[dstKey] = v;
}
