/**
 * The typed error taxonomy for the request-execution primitive (spec §11).
 * The core never throws for an expected failure: it returns an ExecError whose
 * `message` is caller-safe (no internal detail, no target/infra leakage). Deny
 * reasons double as machine-readable audit codes (spec OB-3).
 */
export const EXEC_ERROR_CODES = [
  "DENIED_SCHEME",
  "DENIED_NOT_ALLOWLISTED",
  "DENIED_PRIVATE_IP",
  "DENIED_PORT",
  "DENIED_METHOD",
  "DENIED_REDIRECT_TARGET",
  "DENIED_MALFORMED_URL",
  "LIMIT_RATE",
  "LIMIT_SIZE_REQUEST",
  "LIMIT_SIZE_RESPONSE",
  "TIMEOUT_CONNECT",
  "TIMEOUT_TOTAL",
  "ORIGIN_TLS_ERROR",
  "ORIGIN_UNREACHABLE",
] as const;

export type ExecErrorCode = (typeof EXEC_ERROR_CODES)[number];

export interface ExecError {
  ok: false;
  code: ExecErrorCode;
  /** Caller-safe message. Never contains resolved IPs, internal hosts, or secrets. */
  message: string;
}

/** Caller-safe default messages. Deliberately vague about internals. */
const DEFAULT_MESSAGES: Record<ExecErrorCode, string> = {
  DENIED_SCHEME: "Only http and https requests can be sent from here.",
  DENIED_NOT_ALLOWLISTED:
    "This server isn't declared in the API spec, so it can't be called from here.",
  DENIED_PRIVATE_IP: "This request would target a private or reserved address and was blocked.",
  DENIED_PORT: "This server's port isn't allowed for requests from here.",
  DENIED_METHOD: "This HTTP method isn't permitted for this request.",
  DENIED_REDIRECT_TARGET: "The request was redirected to a destination that isn't allowed.",
  DENIED_MALFORMED_URL: "The request URL is malformed.",
  LIMIT_RATE: "Too many requests. Please wait a moment and try again.",
  LIMIT_SIZE_REQUEST: "The request body is too large.",
  LIMIT_SIZE_RESPONSE: "The response was too large and was truncated.",
  TIMEOUT_CONNECT: "The server took too long to accept the connection.",
  TIMEOUT_TOTAL: "The request timed out.",
  ORIGIN_TLS_ERROR: "The server's TLS certificate could not be verified.",
  ORIGIN_UNREACHABLE: "The server could not be reached.",
};

export function execError(code: ExecErrorCode, message?: string): ExecError {
  return { ok: false, code, message: message ?? DEFAULT_MESSAGES[code] };
}

export function isExecError(value: unknown): value is ExecError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === "string"
  );
}
