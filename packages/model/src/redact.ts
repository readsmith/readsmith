/**
 * Keys whose values are treated as secrets and must never be serialized to
 * logs, job payloads, cached DTOs, or error output. Matched case-insensitively
 * by exact key name only. Exact-match (not substring) is deliberate so that a
 * legitimate field like "author" is never mistaken for "auth".
 */
const DEFAULT_SECRET_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "token",
  "auth",
  "password",
  "secret",
  "apikey",
  "api_key",
  "api-key",
  "x-api-key",
  "access_token",
  "refresh_token",
  "bearer",
  "client_secret",
  "private_key",
]);

export const REDACTED = "[REDACTED]";

/**
 * Return a deep copy of value with any secret-bearing fields replaced by
 * REDACTED. Call before serializing or logging anything that may carry
 * credentials. extraKeys adds caller-specific secret field names.
 */
export function redactSecrets(value: unknown, extraKeys: readonly string[] = []): unknown {
  const secrets = new Set(DEFAULT_SECRET_KEYS);
  for (const k of extraKeys) secrets.add(k.toLowerCase());
  return walk(value, secrets);
}

function walk(value: unknown, secrets: ReadonlySet<string>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => walk(v, secrets));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = secrets.has(key.toLowerCase()) ? REDACTED : walk(v, secrets);
  }
  return out;
}
