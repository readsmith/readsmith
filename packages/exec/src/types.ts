import type { TargetAllowlist } from "./validate.js";

/** Just-in-time auth to inject; resolved late, never logged (spec FR-3, SR-10). */
export type AuthInjection =
  | { kind: "none" }
  | { kind: "apiKey"; in: "header" | "query" | "cookie"; name: string; value: string }
  | { kind: "bearer"; token: string }
  | { kind: "basic"; username: string; password: string };

export type MultipartPart =
  | { name: string; value: string }
  | { name: string; filename: string; contentType?: string; data: Uint8Array };

/** The request body, transport-agnostic; Content-Type is derived from `kind`. */
export type ExecBody =
  | { kind: "json"; value: unknown }
  | { kind: "form"; value: Record<string, string | string[]> }
  | { kind: "multipart"; parts: MultipartPart[] }
  | { kind: "raw"; value: string | Uint8Array; contentType?: string };

/** The normalized, transport-agnostic request the primitive accepts (spec §5). */
export interface ExecRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | string[]>;
  body?: ExecBody;
  auth?: AuthInjection;
}

export interface ExecPolicy {
  allowlist: TargetAllowlist;
  /** Uppercase method names; `["*"]` allows any (the playground policy). */
  allowedMethods: string[];
  followRedirects: "never" | "revalidate-each-hop";
  maxRedirects: number;
  timeouts: { connectMs: number; totalMs: number };
  maxResponseBytes: number;
  maxRequestBytes: number;
  rateLimitKey?: string;
  /** Extra header names (lowercased) to redact from logs, beyond the built-in set. */
  redactHeaders?: string[];
}

/** A fully assembled request ready for a transport to send. */
export interface PreparedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

export interface ExecResult {
  ok: true;
  status: number;
  headers: Record<string, string>;
  /** Response bytes, capped at `maxResponseBytes`; `truncated` when the cap was hit. */
  body: Uint8Array;
  truncated: boolean;
  timing: { totalMs: number; dnsMs?: number; connectMs?: number; ttfbMs?: number };
  finalUrl: string;
}
