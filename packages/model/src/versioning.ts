import { z } from "zod";

/**
 * Every DTO that is written to storage or a queue carries a schema version, so
 * readers can migrate older shapes forward. Bump this when a stored/queued DTO
 * changes shape, and add a migration. Changing a shape without a bump is a CI
 * failure (guarded by the model test suite).
 */
export const CURRENT_SCHEMA_VERSION = "1" as const;

export const schemaVersionSchema = z.string();
export type SchemaVersion = z.infer<typeof schemaVersionSchema>;

/** Attach the current schema version to a versioned DTO payload. */
export function withSchemaVersion<T extends object>(value: T): T & { v: SchemaVersion } {
  return { ...value, v: CURRENT_SCHEMA_VERSION };
}
