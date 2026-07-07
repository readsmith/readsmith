import { redactSecrets } from "@readsmith/model";

/**
 * Mask credentials embedded in any `scheme://user:password@host` URL found in a
 * string (Postgres connection strings, webhook URLs). Leaves the rest intact so
 * logs stay useful. Complements the model's key-based redaction, which does not
 * see secrets hidden inside a plain URL string.
 */
export function maskUrlCredentials(value: string): string {
  return value.replace(/([a-z][a-z0-9+.-]*:\/\/[^:@\s/]+):[^@\s/]+@/gi, "$1:***@");
}

/** Mask the password in a single connection string (URL or key/value form). */
export function redactConnectionString(value: string): string {
  return maskUrlCredentials(value).replace(/(password=)[^\s;]+/gi, "$1***");
}

/**
 * Prepare an arbitrary value for logging: apply the model's exact-key secret
 * redaction, then mask credential URLs in every remaining string. Call this on
 * anything (query context, job payloads, config) before it reaches a log sink.
 */
export function redactForLog(value: unknown): unknown {
  return maskDeep(redactSecrets(value));
}

function maskDeep(value: unknown): unknown {
  if (typeof value === "string") return maskUrlCredentials(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = maskDeep(v);
    }
    return out;
  }
  return value;
}
