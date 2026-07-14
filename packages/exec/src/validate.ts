import { type ExecError, execError, isExecError } from "./errors.js";
import { isForbiddenIp } from "./ip.js";
import { type ParsedTarget, parseTarget } from "./url.js";

/** A pre-validated allowlist entry, derived from a tenant's NormalizedSpec.servers. */
export interface AllowlistEntry {
  scheme: "http" | "https";
  host: string;
  port: number;
}
export type TargetAllowlist = AllowlistEntry[];

/**
 * Build a validated allowlist from a site's OpenAPI server URLs. The spec is
 * attacker-controllable (SR-2), so each declared server must itself parse to a
 * valid http/https target; malformed, non-http, or userinfo-bearing servers are
 * dropped rather than trusted. Templated servers should be resolved to concrete
 * URLs (variable defaults) before this. Only scheme+host+port matter (the
 * request path comes from the operation); deduped on that triple.
 */
export function allowlistFromServers(urls: string[]): TargetAllowlist {
  const seen = new Set<string>();
  const out: TargetAllowlist = [];
  for (const raw of urls) {
    const parsed = parseTarget(raw);
    if (isExecError(parsed)) continue;
    const key = `${parsed.scheme}://${parsed.host}:${parsed.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ scheme: parsed.scheme, host: parsed.host, port: parsed.port });
  }
  return out;
}

type Ok = { ok: true };

function matchAllowlist(
  target: ParsedTarget,
  allowlist: TargetAllowlist,
): "match" | "port" | "none" {
  const host = target.host.toLowerCase();
  const hostKnown = allowlist.some((e) => e.host.toLowerCase() === host);
  if (!hostKnown) return "none";
  const exact = allowlist.some(
    (e) => e.host.toLowerCase() === host && e.scheme === target.scheme && e.port === target.port,
  );
  return exact ? "match" : "port";
}

/**
 * Validate a parsed target against a tenant's allowlist, statically (no DNS).
 * Order matters: an IP-literal target is classified BEFORE the allowlist check,
 * so a metadata/private address is denied even when the (attacker-controlled)
 * spec declared it as a server (spec SR-2: allowlist membership is necessary,
 * not sufficient). Domain targets pass this stage and MUST be re-checked with
 * `checkResolvedIp` after DNS resolution, before connecting (SR-5).
 */
export function checkTarget(target: ParsedTarget, allowlist: TargetAllowlist): Ok | ExecError {
  if (target.scheme !== "http" && target.scheme !== "https") return execError("DENIED_SCHEME");
  if (target.isIpLiteral && isForbiddenIp(target.host)) return execError("DENIED_PRIVATE_IP");
  switch (matchAllowlist(target, allowlist)) {
    case "none":
      return execError("DENIED_NOT_ALLOWLISTED");
    case "port":
      return execError("DENIED_PORT");
    default:
      return { ok: true };
  }
}

/**
 * SR-4/SR-5: the transport calls this with the IP a domain host resolved to,
 * immediately before pinning the connection to that exact IP. Fails closed.
 */
export function checkResolvedIp(ip: string): Ok | ExecError {
  return isForbiddenIp(ip) ? execError("DENIED_PRIVATE_IP") : { ok: true };
}
