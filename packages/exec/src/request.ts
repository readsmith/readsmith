import { type ExecError, execError } from "./errors.js";
import type { ExecBody, ExecRequest, MultipartPart, PreparedRequest } from "./types.js";

// A fixed multipart boundary keeps request construction deterministic (so the
// curl sample and the sent request are byte-identical, spec FR-14). It is long
// and unlikely to collide with body content; if a part contains it, encoding
// fails closed rather than producing a smuggling-vulnerable body.
const MULTIPART_BOUNDARY = "----ReadsmithExecBoundary7e3f9a1c2d4b";
const CRLF = String.fromCharCode(13, 10);

const enc = new TextEncoder();

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 13 || c === 10 || c === 0) return true; // CR, LF, NUL
  }
  return false;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Portable UTF-8 base64 (Node + edge), for HTTP basic auth. */
function toBase64Utf8(value: string): string {
  let binary = "";
  for (const byte of enc.encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodeForm(value: Record<string, string | string[]>): Uint8Array {
  const params = new URLSearchParams();
  for (const [key, val] of Object.entries(value)) {
    if (Array.isArray(val)) for (const v of val) params.append(key, v);
    else params.append(key, val);
  }
  return enc.encode(params.toString());
}

function encodeMultipart(parts: MultipartPart[]): Uint8Array | ExecError {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    if (hasControlChars(part.name)) {
      return execError("DENIED_MALFORMED_URL", "A form field name contains illegal characters.");
    }
    let header = `--${MULTIPART_BOUNDARY}${CRLF}Content-Disposition: form-data; name="${part.name}"`;
    if ("filename" in part) {
      if (hasControlChars(part.filename)) {
        return execError("DENIED_MALFORMED_URL", "A file name contains illegal characters.");
      }
      header += `; filename="${part.filename}"${CRLF}Content-Type: ${part.contentType ?? "application/octet-stream"}`;
    }
    header += `${CRLF}${CRLF}`;
    chunks.push(enc.encode(header));
    chunks.push("data" in part ? part.data : enc.encode(part.value));
    chunks.push(enc.encode(CRLF));
  }
  chunks.push(enc.encode(`--${MULTIPART_BOUNDARY}--${CRLF}`));
  return concatBytes(chunks);
}

/** Encode a body to bytes and its Content-Type, or an ExecError. */
function encodeBody(body: ExecBody): { bytes: Uint8Array; contentType: string } | ExecError {
  switch (body.kind) {
    case "json":
      return { bytes: enc.encode(JSON.stringify(body.value)), contentType: "application/json" };
    case "form":
      return {
        bytes: encodeForm(body.value),
        contentType: "application/x-www-form-urlencoded",
      };
    case "multipart": {
      const bytes = encodeMultipart(body.parts);
      if (!(bytes instanceof Uint8Array)) return bytes;
      return { bytes, contentType: `multipart/form-data; boundary=${MULTIPART_BOUNDARY}` };
    }
    default:
      return {
        bytes: typeof body.value === "string" ? enc.encode(body.value) : body.value,
        contentType: body.contentType ?? "application/octet-stream",
      };
  }
}

/**
 * Assemble a normalized `ExecRequest` into a `PreparedRequest` (spec FR-1..FR-3):
 * merge query params, encode the body with the right Content-Type, and inject
 * auth. Pure and deterministic (same input -> byte-identical output, which is
 * what keeps the curl sample and the sent request in sync, FR-14). Rejects
 * header CRLF injection (SR-9) and oversized bodies. Never throws.
 */
export function buildRequest(
  req: ExecRequest,
  opts: { maxRequestBytes?: number } = {},
): PreparedRequest | ExecError {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return execError("DENIED_MALFORMED_URL");
  }

  // Header names/values must be free of CR/LF/NUL to prevent smuggling (SR-9).
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    if (name.trim() === "" || hasControlChars(name) || hasControlChars(value)) {
      return execError("DENIED_MALFORMED_URL", "A request header contains illegal characters.");
    }
    headers[name.toLowerCase()] = value;
  }

  for (const [key, val] of Object.entries(req.query ?? {})) {
    if (Array.isArray(val)) for (const v of val) url.searchParams.append(key, v);
    else url.searchParams.append(key, val);
  }

  let body: Uint8Array | undefined;
  if (req.body) {
    const encoded = encodeBody(req.body);
    if (!("bytes" in encoded)) return encoded;
    body = encoded.bytes;
    if (!("content-type" in headers)) headers["content-type"] = encoded.contentType;
  }

  // Auth injection happens last, after target validation would have run, and is
  // never logged (redaction handles the log side).
  const auth = req.auth ?? { kind: "none" };
  switch (auth.kind) {
    case "bearer":
      headers.authorization = `Bearer ${auth.token}`;
      break;
    case "basic":
      headers.authorization = `Basic ${toBase64Utf8(`${auth.username}:${auth.password}`)}`;
      break;
    case "apiKey":
      if (auth.in === "header") headers[auth.name.toLowerCase()] = auth.value;
      else if (auth.in === "query") url.searchParams.append(auth.name, auth.value);
      else {
        const existing = headers.cookie ? `${headers.cookie}; ` : "";
        headers.cookie = `${existing}${auth.name}=${auth.value}`;
      }
      break;
    default:
      break;
  }

  if (opts.maxRequestBytes !== undefined && body && body.length > opts.maxRequestBytes) {
    return execError("LIMIT_SIZE_REQUEST");
  }

  return { method: req.method.toUpperCase(), url: url.toString(), headers, body };
}

/** Header names always redacted from logs/traces/errors (spec SR-10). */
const ALWAYS_REDACT = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization"]);

/**
 * Return a copy of headers with credential-bearing values masked, for logging.
 * Never mutates the input. Extra names (from policy) are lowercased and added.
 */
export function redactHeaders(
  headers: Record<string, string>,
  extra: string[] = [],
): Record<string, string> {
  const redact = new Set([...ALWAYS_REDACT, ...extra.map((h) => h.toLowerCase())]);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = redact.has(name.toLowerCase()) ? "[redacted]" : value;
  }
  return out;
}
