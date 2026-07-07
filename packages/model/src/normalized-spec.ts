import { z } from "zod";

/**
 * NormalizedSpec: the API-reference contract. `spec.ingest` produces it from
 * OpenAPI, and every consumer (the reference renderer, endpoint search, MCP
 * tools, later drift probes) reads it instead of raw OpenAPI. Version quirks are
 * normalized away here so consumers handle one shape: allOf is pre-merged,
 * oneOf/anyOf are tagged variants, discriminators are resolved, nullability is
 * folded into the type list, and cycles are marked (never infinitely expanded).
 */

/** Primitive JSON types. Nullability is folded in as the "null" member. */
export const schemaTypeSchema = z.enum([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);
export type SchemaType = z.infer<typeof schemaTypeSchema>;

/**
 * The composition forms that survive normalization: only the variant selectors.
 * allOf is merged into a flat object during ingest; irreconcilable merges are
 * surfaced as `conflicts`, not kept as an allOf node.
 */
export const compositionKindSchema = z.enum(["oneOf", "anyOf"]);
export type CompositionKind = z.infer<typeof compositionKindSchema>;

export interface Discriminator {
  propertyName: string;
  /** Discriminator value to the variant it selects (schema name or label). */
  mapping: Record<string, string>;
}
export const discriminatorSchema: z.ZodType<Discriminator> = z.object({
  propertyName: z.string(),
  mapping: z.record(z.string(), z.string()),
});

/** A marker for an allOf merge that could not be reconciled (rendered as a warning). */
export interface SchemaConflict {
  keyword: string;
  message: string;
}
export const schemaConflictSchema: z.ZodType<SchemaConflict> = z.object({
  keyword: z.string(),
  message: z.string(),
});

/**
 * A normalized schema node. Recursive: properties, items, additionalProperties,
 * and composition variants are themselves NormalizedSchema. A node may instead
 * be a `ref` into NormalizedSpec.schemas, which is how cycles are broken and
 * shared components are reused (the renderer expands refs lazily).
 */
export interface NormalizedSchema {
  /** Reference to a named schema in NormalizedSpec.schemas (breaks cycles / reuse). */
  ref?: string;
  /** Marks a node that participates in a cycle; renderers collapse it by default. */
  cyclic?: boolean;
  type?: SchemaType[];
  format?: string;
  title?: string;
  description?: string;
  deprecated?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  // object
  properties?: Record<string, NormalizedSchema>;
  required?: string[];
  additionalProperties?: boolean | NormalizedSchema;
  minProperties?: number;
  maxProperties?: number;
  // array
  items?: NormalizedSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  // string
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  // number
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  // values
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  example?: unknown;
  examples?: unknown[];
  // variant-selector composition
  composition?: {
    kind: CompositionKind;
    variants: NormalizedSchema[];
    discriminator?: Discriminator;
  };
  /** Merge-conflict markers from an allOf that could not be reconciled. */
  conflicts?: SchemaConflict[];
}

export const normalizedSchemaSchema: z.ZodType<NormalizedSchema> = z.lazy(() =>
  z.object({
    ref: z.string().optional(),
    cyclic: z.boolean().optional(),
    type: z.array(schemaTypeSchema).optional(),
    format: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    deprecated: z.boolean().optional(),
    readOnly: z.boolean().optional(),
    writeOnly: z.boolean().optional(),
    properties: z.record(z.string(), normalizedSchemaSchema).optional(),
    required: z.array(z.string()).optional(),
    additionalProperties: z.union([z.boolean(), normalizedSchemaSchema]).optional(),
    minProperties: z.number().optional(),
    maxProperties: z.number().optional(),
    items: normalizedSchemaSchema.optional(),
    minItems: z.number().optional(),
    maxItems: z.number().optional(),
    uniqueItems: z.boolean().optional(),
    minLength: z.number().optional(),
    maxLength: z.number().optional(),
    pattern: z.string().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    exclusiveMinimum: z.number().optional(),
    exclusiveMaximum: z.number().optional(),
    multipleOf: z.number().optional(),
    enum: z.array(z.unknown()).optional(),
    const: z.unknown().optional(),
    default: z.unknown().optional(),
    example: z.unknown().optional(),
    examples: z.array(z.unknown()).optional(),
    composition: z
      .object({
        kind: compositionKindSchema,
        variants: z.array(normalizedSchemaSchema),
        discriminator: discriminatorSchema.optional(),
      })
      .optional(),
    conflicts: z.array(schemaConflictSchema).optional(),
  }),
);

/** A named example (from an OpenAPI `examples` map), used by the examples picker. */
export interface NamedExample {
  name: string;
  summary?: string;
  description?: string;
  value: unknown;
}
export const namedExampleSchema: z.ZodType<NamedExample> = z.object({
  name: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  value: z.unknown(),
});

export const parameterLocationSchema = z.enum(["path", "query", "header", "cookie"]);
export type ParameterLocation = z.infer<typeof parameterLocationSchema>;

export const parameterSchema = z.object({
  name: z.string(),
  in: parameterLocationSchema,
  required: z.boolean(),
  deprecated: z.boolean().optional(),
  description: z.string().optional(),
  schema: normalizedSchemaSchema,
  example: z.unknown().optional(),
});
export type Parameter = z.infer<typeof parameterSchema>;

export const mediaTypeSchema = z.object({
  schema: normalizedSchemaSchema,
  examples: z.array(namedExampleSchema).optional(),
});
export type MediaType = z.infer<typeof mediaTypeSchema>;

export const requestBodySchema = z.object({
  required: z.boolean(),
  description: z.string().optional(),
  content: z.record(z.string(), mediaTypeSchema),
});
export type RequestBody = z.infer<typeof requestBodySchema>;

/** A response keyed by status (for example "200", "4XX", or "default"). */
export const apiResponseSchema = z.object({
  status: z.string(),
  description: z.string().optional(),
  content: z.record(z.string(), mediaTypeSchema).optional(),
});
export type ApiResponse = z.infer<typeof apiResponseSchema>;

export const codeSampleSchema = z.object({
  lang: z.string(),
  label: z.string(),
  source: z.string(),
});
export type CodeSample = z.infer<typeof codeSampleSchema>;

export const httpMethodSchema = z.enum([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);
export type HttpMethod = z.infer<typeof httpMethodSchema>;

/** An OpenAPI security requirement: scheme name to the scopes it needs. */
export const securityRequirementSchema = z.record(z.string(), z.array(z.string()));
export type SecurityRequirement = z.infer<typeof securityRequirementSchema>;

export const operationSchema = z.object({
  /** Stable across re-ingest: operationId, or hash(method+path). */
  id: z.string(),
  method: httpMethodSchema,
  path: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  deprecated: z.boolean(),
  tags: z.array(z.string()),
  parameters: z.array(parameterSchema),
  requestBody: requestBodySchema.optional(),
  responses: z.array(apiResponseSchema),
  security: z.array(securityRequirementSchema).optional(),
  /** Authored `x-codeSamples`, when present. */
  codeSamples: z.array(codeSampleSchema).optional(),
});
export type Operation = z.infer<typeof operationSchema>;

export const oauthFlowSchema = z.object({
  authorizationUrl: z.string().optional(),
  tokenUrl: z.string().optional(),
  refreshUrl: z.string().optional(),
  scopes: z.record(z.string(), z.string()),
});
export type OAuthFlow = z.infer<typeof oauthFlowSchema>;

export const securitySchemeSchema = z.object({
  type: z.enum(["apiKey", "http", "oauth2", "openIdConnect", "mutualTLS"]),
  description: z.string().optional(),
  name: z.string().optional(),
  in: z.enum(["query", "header", "cookie"]).optional(),
  scheme: z.string().optional(),
  bearerFormat: z.string().optional(),
  flows: z.record(z.string(), oauthFlowSchema).optional(),
  openIdConnectUrl: z.string().optional(),
});
export type SecurityScheme = z.infer<typeof securitySchemeSchema>;

export const serverVariableSchema = z.object({
  default: z.string(),
  enum: z.array(z.string()).optional(),
  description: z.string().optional(),
});
export const serverSchema = z.object({
  url: z.string(),
  description: z.string().optional(),
  variables: z.record(z.string(), serverVariableSchema).optional(),
});
export type Server = z.infer<typeof serverSchema>;

export const tagSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});
export type Tag = z.infer<typeof tagSchema>;

export const infoSchema = z.object({
  title: z.string(),
  version: z.string(),
  description: z.string().optional(),
});
export type Info = z.infer<typeof infoSchema>;

export const normalizedSpecSchema = z.object({
  specId: z.string(),
  siteId: z.string(),
  /** The ingest content version for this spec's source path. */
  version: z.number().int(),
  /** Hash of the source bytes; feeds idempotency and change detection. */
  sourceHash: z.string(),
  info: infoSchema,
  servers: z.array(serverSchema),
  securitySchemes: z.record(z.string(), securitySchemeSchema),
  tags: z.array(tagSchema),
  operations: z.array(operationSchema),
  /** Named component schemas, the targets of `ref` nodes. */
  schemas: z.record(z.string(), normalizedSchemaSchema),
});
export type NormalizedSpec = z.infer<typeof normalizedSpecSchema>;
