import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { type RequestOptions, request as httpsRequest } from "node:https";
import { type ExecError, execError, isExecError } from "./errors.js";
import { buildRequest } from "./request.js";
import type { ExecPolicy, ExecRequest, ExecResult, PreparedRequest } from "./types.js";
import { parseTarget } from "./url.js";
import { type TargetAllowlist, checkResolvedIp, checkTarget } from "./validate.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface SendOptions {
  timeouts: { connectMs: number; totalMs: number };
  maxResponseBytes: number;
}

export interface ExecNodeDeps {
  /** Resolve a hostname to its IP addresses. Injectable for tests; defaults to node:dns. */
  resolve?: (host: string) => Promise<string[]>;
  /** The pinned-connect sender. Injectable for tests; defaults to `sendPinned`. */
  send?: (
    prepared: PreparedRequest,
    pinnedIp: string,
    opts: SendOptions,
  ) => Promise<ExecResult | ExecError>;
}

/** Sensible policy defaults for the playground; hosts may override any field. */
export interface ExecServiceOptions {
  allowlist: TargetAllowlist;
  allowedMethods?: string[];
  followRedirects?: "never" | "revalidate-each-hop";
  maxRedirects?: number;
  timeouts?: { connectMs: number; totalMs: number };
  maxResponseBytes?: number;
  maxRequestBytes?: number;
}

/** The structural shape a host wires into `ApiDeps.exec` (matched by duck typing). */
export interface ExecServiceLike {
  enabled: boolean;
  run(req: ExecRequest): Promise<ExecResult | ExecError>;
}

/**
 * Compose an ExecService from a site's allowlist. `enabled` is false when the
 * site declares no servers, so the playground route stays off for docs-only
 * sites. `run` binds the allowlist into a policy and executes via the pinned
 * transport. This is the host-composition seam (self-host and cloud both wire
 * it into `ApiDeps.exec`); the API route stays allowlist-free.
 */
export function createExecService(
  opts: ExecServiceOptions,
  deps: ExecNodeDeps = {},
): ExecServiceLike {
  const policy: ExecPolicy = {
    allowlist: opts.allowlist,
    allowedMethods: opts.allowedMethods ?? ["*"],
    followRedirects: opts.followRedirects ?? "never",
    maxRedirects: opts.maxRedirects ?? 3,
    timeouts: opts.timeouts ?? { connectMs: 5000, totalMs: 30_000 },
    maxResponseBytes: opts.maxResponseBytes ?? 10_000_000,
    maxRequestBytes: opts.maxRequestBytes ?? 10_000_000,
  };
  return {
    enabled: opts.allowlist.length > 0,
    run: (req) => execNode(req, policy, deps),
  };
}

async function defaultResolve(host: string): Promise<string[]> {
  const records = await dnsLookup(host, { all: true });
  return records.map((r) => r.address);
}

function flattenHeaders(
  raw: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function mapSocketError(err: NodeJS.ErrnoException): ExecError {
  const code = err.code ?? "";
  if (/CERT|TLS|SSL|ERR_TLS|SELF_SIGNED/i.test(code) || /certificate/i.test(err.message)) {
    return execError("ORIGIN_TLS_ERROR");
  }
  return execError("ORIGIN_UNREACHABLE");
}

/**
 * Send a prepared request, connecting to a PRE-VALIDATED pinned IP (spec SR-5).
 * The connection target is the IP the caller already classified as safe; the
 * `Host` header and TLS servername stay the original hostname, so certificate
 * validation is correct and the socket can never be rebound to a different
 * address between the check and the connect. This function does NOT validate or
 * follow redirects; it returns whatever the origin returned (3xx included).
 */
export function sendPinned(
  prepared: PreparedRequest,
  pinnedIp: string,
  opts: SendOptions,
): Promise<ExecResult | ExecError> {
  const url = new URL(prepared.url);
  const isHttps = url.protocol === "https:";
  const port = url.port === "" ? (isHttps ? 443 : 80) : Number(url.port);
  const started = performance.now();
  let ttfbMs: number | undefined;

  return new Promise((resolve) => {
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const finish = (result: ExecResult | ExecError) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      resolve(result);
    };

    const options: RequestOptions = {
      method: prepared.method,
      protocol: url.protocol,
      // Connect straight to the validated IP (an IP literal => no DNS lookup).
      hostname: pinnedIp,
      port,
      path: `${url.pathname}${url.search}`,
      headers: { ...prepared.headers, host: url.host },
    };
    if (isHttps) options.servername = url.hostname; // SNI + cert identity = the real host

    const send = isHttps ? httpsRequest : httpRequest;
    const clientReq = send(options, (res) => {
      ttfbMs = performance.now() - started;
      const chunks: Uint8Array[] = [];
      let received = 0;
      let truncated = false;
      res.on("data", (chunk: Buffer) => {
        if (received >= opts.maxResponseBytes) return;
        const remaining = opts.maxResponseBytes - received;
        if (chunk.length > remaining) {
          chunks.push(new Uint8Array(chunk.subarray(0, remaining)));
          received += remaining;
          truncated = true;
          res.destroy();
        } else {
          chunks.push(new Uint8Array(chunk));
          received += chunk.length;
        }
      });
      const complete = () => {
        const body = new Uint8Array(received);
        let offset = 0;
        for (const c of chunks) {
          body.set(c, offset);
          offset += c.length;
        }
        finish({
          ok: true,
          status: res.statusCode ?? 0,
          headers: flattenHeaders(res.headers),
          body,
          truncated,
          timing: { totalMs: performance.now() - started, ttfbMs },
          finalUrl: prepared.url,
        });
      };
      res.on("end", complete);
      res.on("close", complete);
      res.on("error", () => finish(execError("ORIGIN_UNREACHABLE")));
    });

    timers.push(
      setTimeout(() => {
        clientReq.destroy();
        finish(execError("TIMEOUT_TOTAL"));
      }, opts.timeouts.totalMs),
    );
    clientReq.on("socket", (socket) => {
      const connectTimer = setTimeout(() => {
        clientReq.destroy();
        finish(execError("TIMEOUT_CONNECT"));
      }, opts.timeouts.connectMs);
      timers.push(connectTimer);
      socket.on("connect", () => clearTimeout(connectTimer));
    });
    clientReq.on("error", (err: NodeJS.ErrnoException) => finish(mapSocketError(err)));

    if (prepared.body) clientReq.write(Buffer.from(prepared.body));
    clientReq.end();
  });
}

/**
 * Compute the next request after a redirect, or null to stop. Cross-origin hops
 * strip credentials (SR-12); 303 (and POST on 301/302) becomes a bodyless GET.
 * Pure and unit-testable without a network.
 */
export function planRedirect(
  current: ExecRequest,
  currentFinalUrl: string,
  status: number,
  location: string | undefined,
): ExecRequest | null {
  if (!location) return null;
  let nextUrl: string;
  try {
    nextUrl = new URL(location, currentFinalUrl).toString();
  } catch {
    return null;
  }
  const crossOrigin = new URL(nextUrl).origin !== new URL(currentFinalUrl).origin;

  let method = current.method.toUpperCase();
  let body = current.body;
  if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
    method = "GET";
    body = undefined;
  }

  const headers: Record<string, string> = { ...(current.headers ?? {}) };
  let auth = current.auth;
  if (crossOrigin) {
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase();
      if (lower === "authorization" || lower === "cookie") delete headers[name];
    }
    auth = { kind: "none" };
  }
  return { ...current, url: nextUrl, method, headers, body, auth };
}

/**
 * The full Node execution flow: method gate -> parse+validate target -> build
 * request -> resolve + re-validate the resolved IP (SR-4/SR-5) -> pinned send,
 * with redirect handling per policy. Returns a typed ExecResult or ExecError;
 * never throws.
 */
export async function execNode(
  req: ExecRequest,
  policy: ExecPolicy,
  deps: ExecNodeDeps = {},
): Promise<ExecResult | ExecError> {
  const resolve = deps.resolve ?? defaultResolve;
  const send = deps.send ?? sendPinned;
  const sendOpts: SendOptions = {
    timeouts: policy.timeouts,
    maxResponseBytes: policy.maxResponseBytes,
  };

  let current = req;
  for (let hop = 0; ; hop++) {
    const method = current.method.toUpperCase();
    if (!policy.allowedMethods.includes("*") && !policy.allowedMethods.includes(method)) {
      return execError("DENIED_METHOD");
    }

    const parsed = parseTarget(current.url);
    if (isExecError(parsed)) return parsed;
    const staticCheck = checkTarget(parsed, policy.allowlist);
    if (isExecError(staticCheck)) return staticCheck;

    const prepared = buildRequest(current, { maxRequestBytes: policy.maxRequestBytes });
    if (isExecError(prepared)) return prepared;

    // Resolve a domain and re-validate every address it maps to before we pin
    // the connection. IP-literal hosts were already classified in checkTarget.
    let pinnedIp = parsed.host;
    if (!parsed.isIpLiteral) {
      let addresses: string[];
      try {
        addresses = await resolve(parsed.host);
      } catch {
        return execError("ORIGIN_UNREACHABLE");
      }
      if (addresses.length === 0) return execError("ORIGIN_UNREACHABLE");
      for (const ip of addresses) {
        const check = checkResolvedIp(ip);
        if (isExecError(check)) return check; // any forbidden address fails closed (SR-5)
      }
      pinnedIp = addresses[0] ?? "";
    }

    const result = await send(prepared, pinnedIp, sendOpts);
    if (isExecError(result)) return result;

    const wantsRedirect =
      policy.followRedirects === "revalidate-each-hop" &&
      REDIRECT_STATUSES.has(result.status) &&
      hop < policy.maxRedirects;
    if (!wantsRedirect) return result;

    const next = planRedirect(current, result.finalUrl, result.status, result.headers.location);
    if (!next) return result;
    current = next;
  }
}
