import { createHash } from "node:crypto";

/**
 * Recursively normalize a value so that object keys are in a stable, sorted
 * order. Arrays keep their order (order is meaningful); objects are sorted by
 * key; undefined values are dropped to mirror JSON.stringify.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

/**
 * Deterministic JSON serialization: same content produces the same string
 * regardless of original key order. This is what makes content hashing and
 * cache keys correct across runs, machines, and languages.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * A stable content hash (sha256 hex) of any serializable value, computed over
 * its canonical form. Use for cache keys and deployment hashes.
 */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
