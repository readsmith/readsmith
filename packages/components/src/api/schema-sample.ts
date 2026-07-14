import type { NormalizedSchema } from "@readsmith/model";

/*
 * Schema sampling: turn a normalized JSON schema into a concrete example value.
 * Shared by the response panel (which shows a synthesized success body) and the
 * playground body skeleton (required keys filled, optional keys commented). The
 * `direction` decides which conditional fields are dropped: a request omits
 * `readOnly` fields (server-assigned), a response omits `writeOnly` ones.
 */

export type SampleDirection = "request" | "response";

/** Synthesize an example value for a schema, following refs and stopping at cycles. */
export function synthExample(
  schema: NormalizedSchema | undefined,
  schemas: Record<string, NormalizedSchema>,
  direction: SampleDirection = "response",
  seen: ReadonlySet<string> = new Set(),
  depth = 0,
): unknown {
  if (!schema || depth > 8) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.ref !== undefined) {
    if (seen.has(schema.ref)) return null; // cycle
    const target = schemas[schema.ref];
    if (!target) return null;
    return synthExample(target, schemas, direction, new Set([...seen, schema.ref]), depth + 1);
  }
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  if (schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (dropped(prop, direction)) continue;
      out[key] = synthExample(prop, schemas, direction, seen, depth + 1);
    }
    return out;
  }
  const type = (schema.type ?? []).find((t) => t !== "null");
  if (type === "array") return [synthExample(schema.items, schemas, direction, seen, depth + 1)];
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

/** A field a request or response never carries: readOnly in requests, writeOnly in responses. */
function dropped(prop: NormalizedSchema, direction: SampleDirection): boolean {
  return direction === "request" ? prop.readOnly === true : prop.writeOnly === true;
}

/** Resolve a top-level `ref` so we can read the object's own `properties`/`required`. */
function deref(
  schema: NormalizedSchema,
  schemas: Record<string, NormalizedSchema>,
): NormalizedSchema {
  const seen = new Set<string>();
  let node = schema;
  while (node.ref !== undefined && !seen.has(node.ref)) {
    seen.add(node.ref);
    const target = schemas[node.ref];
    if (!target) break;
    node = target;
  }
  return node;
}

/**
 * A ready-to-send JSON body skeleton for the playground. Required properties are
 * present with a synthesized placeholder; optional ones are listed as `//`
 * commented lines so a reader can discover and enable them without leaving the
 * form. Not strict JSON (comments, trailing commas): `jsoncToJson` normalizes it
 * back to valid JSON for the curl and the request that is actually sent.
 */
export function sampleBodySkeleton(
  schema: NormalizedSchema,
  schemas: Record<string, NormalizedSchema>,
): string {
  const object = deref(schema, schemas);
  const properties = object.properties;
  if (!properties) {
    const value = synthExample(schema, schemas, "request");
    return JSON.stringify(value ?? {}, null, 2);
  }
  const required = new Set(object.required ?? []);
  const lines: string[] = [];
  for (const [key, prop] of Object.entries(properties)) {
    if (dropped(prop, "request")) continue;
    const value = synthExample(prop, schemas, "request");
    const core = `${JSON.stringify(key)}: ${JSON.stringify(value === undefined ? null : value)}`;
    lines.push(required.has(key) ? `  ${core}` : `  // ${core}`);
  }
  if (lines.length === 0) return "{}";
  return `{\n${lines.join(",\n")}\n}`;
}

/**
 * Normalize a JSONC body (the skeleton, or a reader's edit of it) to valid JSON:
 * strip `//` and block comments that are not inside a string, drop trailing
 * commas, then re-serialize if it parses. String-aware so a `//` inside a value
 * (a URL, say) is preserved. On a parse failure the comment-stripped text is
 * returned so the target API surfaces the error rather than us sending comments.
 */
export function jsoncToJson(text: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (c === quote) {
        inString = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // skip the closing slash of the block comment
      continue;
    }
    out += c;
  }
  const withoutTrailingCommas = out.replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.stringify(JSON.parse(withoutTrailingCommas));
  } catch {
    return withoutTrailingCommas.trim();
  }
}
