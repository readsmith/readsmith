import { type ExecError, execError } from "./errors.js";
import { isIpLiteral } from "./ip.js";

/**
 * A parsed, normalized target. `host` is the canonical hostname the WHATWG URL
 * parser produced (lowercased, IPv6 brackets stripped, and crucially with
 * non-decimal IPv4 encodings like 0x7f000001 / 2130706433 / 017700000001
 * already normalized to dotted-decimal), so downstream classification sees the
 * real host, never the obfuscated string (spec SR-6).
 */
export interface ParsedTarget {
  scheme: "http" | "https";
  host: string;
  port: number;
  isIpLiteral: boolean;
}

const BACKSLASH = 0x5c;

/**
 * Control chars (CR/LF/NUL/tab), space, DEL, and backslash are rejected before
 * parsing: they enable header injection / request smuggling and parser-
 * differential tricks (spec SR-6, SR-9). Scanned by code point to avoid any
 * regex/string-escaping ambiguity around backslash.
 */
function hasIllegalUrlChars(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === BACKSLASH) return true;
  }
  return false;
}

/**
 * Parse and normalize a raw target URL, rejecting the obfuscations SR-6 calls
 * out. Returns a `ParsedTarget` or a typed `ExecError` (never throws).
 */
export function parseTarget(raw: string): ParsedTarget | ExecError {
  if (typeof raw !== "string" || raw.length === 0) return execError("DENIED_MALFORMED_URL");
  if (hasIllegalUrlChars(raw)) {
    return execError("DENIED_MALFORMED_URL", "The request URL contains illegal characters.");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return execError("DENIED_MALFORMED_URL");
  }

  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") return execError("DENIED_SCHEME");

  // Userinfo (`http://allowed@evil`) is a classic allowlist-bypass trick.
  if (parsed.username !== "" || parsed.password !== "") {
    return execError("DENIED_MALFORMED_URL", "Credentials in the URL are not allowed.");
  }

  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1); // strip IPv6 brackets
  if (host === "") return execError("DENIED_MALFORMED_URL");

  const port = parsed.port === "" ? (scheme === "https" ? 443 : 80) : Number(parsed.port);

  return { scheme, host, port, isIpLiteral: isIpLiteral(host) };
}
