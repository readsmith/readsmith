import { z } from "zod";
import { diagnosticSchema, positionSchema } from "./common.js";
import { normalizedSpecSchema } from "./normalized-spec.js";

/**
 * The registry of top-level schemas we publish JSON-Schema for. JSON-Schema
 * powers cross-language validation (the TS to Python boundary) and editor
 * autocomplete. Add every boundary DTO here as its milestone lands.
 */
export const schemaRegistry = {
  position: positionSchema,
  diagnostic: diagnosticSchema,
  normalizedSpec: normalizedSpecSchema,
} as const;

export type SchemaName = keyof typeof schemaRegistry;

/** Convert a single Zod schema to a JSON-Schema document. */
export function toJsonSchema(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema);
}

/** Export JSON-Schema for every registered schema, keyed by name. */
export function exportAllJsonSchemas(): Record<SchemaName, unknown> {
  const out = {} as Record<SchemaName, unknown>;
  for (const name of Object.keys(schemaRegistry) as SchemaName[]) {
    out[name] = toJsonSchema(schemaRegistry[name]);
  }
  return out;
}
