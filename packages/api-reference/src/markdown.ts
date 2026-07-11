import type {
  NormalizedSchema,
  NormalizedSpec,
  Operation,
  Parameter,
  SecurityScheme,
} from "@readsmith/model";

/**
 * The slice of a spec these functions read. Both the persisted NormalizedSpec
 * and the in-process NormalizedContent (normalize output) satisfy it.
 */
export type OperationContext = Pick<NormalizedSpec, "operations" | "schemas" | "securitySchemes">;

/*
 * The markdown projection of an operation: the generated reference sections
 * (auth, parameters, request body, responses) as deterministic markdown. This
 * is what agent surfaces see: a hybrid page's rawMd is the authored prose plus
 * this projection, so the .md route, llms.txt, and search chunks carry the full
 * contract per operation. Pure and renderer-free: same inputs, same bytes.
 */

/** Look up an operation by HTTP method (case-insensitive) and exact path. */
export function findOperation(
  spec: Pick<OperationContext, "operations">,
  method: string,
  path: string,
): Operation | undefined {
  const m = method.trim().toLowerCase();
  const p = path.trim();
  return spec.operations.find((op) => op.method === m && op.path === p);
}

/** Bounds ref expansion: a branch never revisits a named schema, and depth is capped. */
const MAX_DEPTH = 6;

/**
 * The markdown projection of one named component schema (a data-model page's
 * generated half): name, description, and the full field walk with the same
 * rules as the operation projection. Empty string when the name is unknown.
 */
export function schemaToMarkdown(name: string, spec: OperationContext): string {
  const schema = spec.schemas[name];
  if (!schema) return "";
  const out = [`\`${name}\``, ""];
  if (schema.description) out.push(schema.description.trim(), "");
  // Seed the seen-set with the schema itself, so self-references collapse.
  out.push(...schemaLines(schema, spec, 0, new Set([name])), "");
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

export function operationToMarkdown(op: Operation, spec: OperationContext): string {
  const out: string[] = [`\`${op.method.toUpperCase()} ${op.path}\``, ""];
  if (op.deprecated) out.push("**Deprecated.**", "");
  if (op.description) out.push(oneParagraph(op.description), "");

  const auth = authSection(op, spec);
  if (auth) out.push(auth);
  out.push(...parameterSections(op, spec));

  if (op.requestBody) {
    out.push("### Request body", "");
    if (op.requestBody.description) out.push(oneParagraph(op.requestBody.description), "");
    for (const [mediaType, media] of Object.entries(op.requestBody.content)) {
      out.push(`\`${mediaType}\`${op.requestBody.required ? " · required" : ""}`, "");
      out.push(...schemaLines(media.schema, spec, 0, new Set()), "");
    }
  }

  if (op.responses.length > 0) {
    out.push("### Responses", "");
    const sorted = [...op.responses].sort((a, b) => a.status.localeCompare(b.status));
    for (const response of sorted) {
      const desc = response.description ? ` — ${oneLine(response.description)}` : "";
      out.push(`**${response.status}**${desc}`, "");
      for (const [mediaType, media] of Object.entries(response.content ?? {})) {
        out.push(`\`${mediaType}\`:`, "");
        out.push(...schemaLines(media.schema, spec, 0, new Set()), "");
      }
    }
  }

  // Collapse the accumulated blank-line bookkeeping into clean paragraphs.
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

function authSection(op: Operation, spec: OperationContext): string | null {
  const names = op.security
    ? [...new Set(op.security.flatMap((req) => Object.keys(req)))]
    : Object.keys(spec.securitySchemes);
  const rows = names
    .map((name) => [name, spec.securitySchemes[name]] as const)
    .filter((entry): entry is [string, SecurityScheme] => entry[1] !== undefined)
    .map(([name, scheme]) => {
      const desc = scheme.description ? ` ${oneLine(scheme.description)}` : "";
      return `- \`${name}\` — ${schemeText(scheme)}${desc}`;
    });
  if (rows.length === 0) return null;
  return ["### Authorizations", "", ...rows, ""].join("\n");
}

function schemeText(scheme: SecurityScheme): string {
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

const LOCATION_ORDER: Parameter["in"][] = ["path", "query", "header", "cookie"];
const LOCATION_LABEL: Record<Parameter["in"], string> = {
  path: "Path parameters",
  query: "Query parameters",
  header: "Header parameters",
  cookie: "Cookie parameters",
};

function parameterSections(op: Operation, spec: OperationContext): string[] {
  const out: string[] = [];
  for (const location of LOCATION_ORDER) {
    const params = op.parameters.filter((p) => p.in === location);
    if (params.length === 0) continue;
    out.push(`### ${LOCATION_LABEL[location]}`, "");
    for (const param of params) {
      const description = param.description ?? param.schema.description;
      out.push(
        fieldLine(param.name, param.schema, spec, {
          required: param.required,
          deprecated: param.deprecated === true,
          description,
        }),
      );
      out.push(...childLines(param.schema, spec, 1, new Set()));
    }
    out.push("");
  }
  return out;
}

/** Object properties (and array items) of a schema as indented field lines. */
function schemaLines(
  schema: NormalizedSchema,
  spec: OperationContext,
  indent: number,
  seen: ReadonlySet<string>,
): string[] {
  const resolved = resolveRef(schema, spec, seen);
  if (resolved === null) return [`${pad(indent)}- (recursive)`];
  const { node, nextSeen } = resolved;

  if (node.properties) {
    const required = new Set(node.required ?? []);
    const out: string[] = [];
    for (const [name, prop] of Object.entries(node.properties)) {
      out.push(
        fieldLine(name, prop, spec, {
          required: required.has(name),
          deprecated: prop.deprecated === true,
          description: prop.description,
          indent,
        }),
      );
      out.push(...childLines(prop, spec, indent + 1, nextSeen));
    }
    return out;
  }
  if (node.items) return schemaLines(node.items, spec, indent, nextSeen);
  if (node.composition) {
    return node.composition.variants.flatMap((variant, i) => [
      `${pad(indent)}- ${node.composition?.kind === "oneOf" ? "one of" : "any of"} (variant ${i + 1}): ${typeLabel(variant, spec)}`,
      ...schemaLines(variant, spec, indent + 1, nextSeen),
    ]);
  }
  return [];
}

/** The nested lines under one field, when it has structure worth walking into. */
function childLines(
  schema: NormalizedSchema,
  spec: OperationContext,
  indent: number,
  seen: ReadonlySet<string>,
): string[] {
  if (indent > MAX_DEPTH) return [`${pad(indent)}- (depth capped)`];
  const resolved = resolveRef(schema, spec, seen);
  if (resolved === null) return [`${pad(indent)}- (recursive)`];
  const { node, nextSeen } = resolved;
  if (node.properties) return schemaLines(node, spec, indent, seen);
  if (node.items) return childLines(node.items, spec, indent, nextSeen);
  if (node.composition) return schemaLines(node, spec, indent, seen);
  return [];
}

/** Resolve a ref node to its target; null means a cycle (the caller marks it). */
function resolveRef(
  schema: NormalizedSchema,
  spec: OperationContext,
  seen: ReadonlySet<string>,
): { node: NormalizedSchema; nextSeen: ReadonlySet<string> } | null {
  if (schema.ref === undefined) return { node: schema, nextSeen: seen };
  if (schema.cyclic || seen.has(schema.ref)) return null;
  const target = spec.schemas[schema.ref];
  if (!target) return { node: {}, nextSeen: seen };
  return { node: target, nextSeen: new Set([...seen, schema.ref]) };
}

function fieldLine(
  name: string,
  schema: NormalizedSchema,
  spec: OperationContext,
  meta: { required: boolean; deprecated?: boolean; description?: string; indent?: number },
): string {
  const parts = [`${pad(meta.indent ?? 0)}- \`${name}\` ${typeLabel(schema, spec)}`];
  parts.push(meta.required ? "required" : "optional");
  if (schema.readOnly) parts.push("read-only");
  if (schema.writeOnly) parts.push("write-only");
  if (meta.deprecated || schema.deprecated) parts.push("deprecated");
  const constraints = constraintText(schema);
  if (constraints) parts.push(constraints);
  const line = parts.join(" · ");
  return meta.description ? `${line} — ${oneLine(meta.description)}` : line;
}

/** A compact type label: ref names verbatim, arrays recursive, formats attached. */
function typeLabel(schema: NormalizedSchema, spec: OperationContext): string {
  if (schema.ref !== undefined) return schema.ref;
  if (schema.composition) {
    const kind = schema.composition.kind === "oneOf" ? "one of" : "any of";
    return `${kind}: ${schema.composition.variants.map((v) => typeLabel(v, spec)).join(" | ")}`;
  }
  const types = schema.type ?? [];
  const base = types.find((t) => t !== "null");
  let label: string;
  if (base === "array") {
    label = schema.items ? `array of ${typeLabel(schema.items, spec)}` : "array";
  } else {
    label = base ?? "any";
  }
  if (schema.format) label = `${label} (${schema.format})`;
  if (types.includes("null")) label = `${label} | null`;
  return label;
}

/** Constraints in a fixed order, so the projection is stable. */
function constraintText(schema: NormalizedSchema): string {
  const parts: string[] = [];
  if (schema.default !== undefined) parts.push(`default: ${literal(schema.default)}`);
  if (schema.const !== undefined) parts.push(`const: ${literal(schema.const)}`);
  if (schema.enum && schema.enum.length > 0) {
    parts.push(`options: ${schema.enum.map(literal).join(", ")}`);
  }
  if (schema.minLength !== undefined) parts.push(`min length: ${schema.minLength}`);
  if (schema.maxLength !== undefined) parts.push(`max length: ${schema.maxLength}`);
  if (schema.pattern !== undefined) parts.push(`pattern: \`${schema.pattern}\``);
  if (schema.minimum !== undefined) parts.push(`minimum: ${schema.minimum}`);
  if (schema.maximum !== undefined) parts.push(`maximum: ${schema.maximum}`);
  if (schema.exclusiveMinimum !== undefined) parts.push(`above: ${schema.exclusiveMinimum}`);
  if (schema.exclusiveMaximum !== undefined) parts.push(`below: ${schema.exclusiveMaximum}`);
  if (schema.multipleOf !== undefined) parts.push(`multiple of: ${schema.multipleOf}`);
  if (schema.minItems !== undefined) parts.push(`min items: ${schema.minItems}`);
  if (schema.maxItems !== undefined) parts.push(`max items: ${schema.maxItems}`);
  if (schema.uniqueItems) parts.push("unique items");
  if (schema.minProperties !== undefined) parts.push(`min properties: ${schema.minProperties}`);
  if (schema.maxProperties !== undefined) parts.push(`max properties: ${schema.maxProperties}`);
  return parts.join(" · ");
}

function literal(value: unknown): string {
  return `\`${JSON.stringify(value)}\``;
}

/** Collapse internal newlines: descriptions become one line in list rows. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Keep paragraph text intact but normalize trailing whitespace. */
function oneParagraph(text: string): string {
  return text.trim();
}

function pad(indent: number): string {
  return "  ".repeat(indent);
}
