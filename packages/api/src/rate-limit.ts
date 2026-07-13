import type { MiddlewareHandler } from "hono";
import { z } from "zod";

/**
 * Rate limiting is safety, not metering. It exists so that a self-hoster who puts
 * a real provider key in `.env` and points DNS at the box does not wake up to a
 * drained account: `POST /api/ask` is otherwise an unauthenticated, unmetered LLM
 * endpoint billed to whoever deployed it. Quotas, per-account caps, and billing
 * are a hosted-tier product concern and are deliberately not here.
 *
 * This is defense in depth, never the only line. An operator should still put an
 * edge limiter in front and cap spend at the provider.
 */

/**
 * The counter surface the limiter needs: deliberately narrower than any one
 * driver, exactly as `ApiDatabase` is narrower than any Postgres client. A
 * `Cache` from `@readsmith/cache` satisfies it structurally, so the memory driver
 * works for single-node self-host and a Redis driver works for multi-instance
 * hosted, with no change here and no dependency from this package.
 */
export interface CounterCache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
}

export const rateLimitPolicySchema = z.object({
  /** Requests permitted per window. */
  limit: z.number().int().positive(),
  /** Window length in milliseconds. */
  windowMs: z.number().int().positive(),
});
export type RateLimitPolicy = z.infer<typeof rateLimitPolicySchema>;

/** The buckets we limit. `mcp` is enforced by the host: it is served outside `/api`. */
export const RATE_LIMIT_BUCKETS = ["ask", "search", "mcp", "exec"] as const;
export type RateLimitBucket = (typeof RATE_LIMIT_BUCKETS)[number];

/**
 * Generous enough that a human reader never sees a 429, tight enough that a
 * scripted loop does. `ask` is strictest because it is the only bucket that costs
 * money per request.
 */
export const DEFAULT_RATE_LIMITS: Record<RateLimitBucket, RateLimitPolicy> = {
  ask: { limit: 10, windowMs: 60_000 },
  search: { limit: 60, windowMs: 60_000 },
  mcp: { limit: 60, windowMs: 60_000 },
  // `exec` (the API-playground proxy) is a human-driven "Try It" surface, and
  // each call is an outbound request on our IP, so it is bounded but generous.
  exec: { limit: 30, windowMs: 60_000 },
};

export const rateLimitConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * The header carrying the real client IP, when the app runs behind a proxy that
   * sets it (for example `cf-connecting-ip`). Unset means we do not read any
   * forwarding header at all. See `clientKey` for why that default matters.
   */
  trustedHeader: z.string().min(1).optional(),
  ask: rateLimitPolicySchema.default(DEFAULT_RATE_LIMITS.ask),
  search: rateLimitPolicySchema.default(DEFAULT_RATE_LIMITS.search),
  mcp: rateLimitPolicySchema.default(DEFAULT_RATE_LIMITS.mcp),
  exec: rateLimitPolicySchema.default(DEFAULT_RATE_LIMITS.exec),
});
export type RateLimitConfig = z.infer<typeof rateLimitConfigSchema>;

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets. At least 1, so `Retry-After: 0` never ships. */
  retryAfterSeconds: number;
  resetAtMs: number;
}

const ALLOWED_UNLIMITED: RateLimitDecision = {
  allowed: true,
  limit: 0,
  remaining: 0,
  retryAfterSeconds: 0,
  resetAtMs: 0,
};

/**
 * Identify the caller.
 *
 * When no trusted header is configured we fall back to the socket address, and
 * failing that to a single shared bucket. We never read `X-Forwarded-For` on
 * spec: it is client-settable, so honoring it by default would let an attacker
 * mint a fresh counter on every request and walk straight through the limiter.
 * A shared bucket throttles honest readers together, which is a bad day. An
 * unenforced limiter is a drained account, which is a worse one.
 */
export function clientKey(headers: Headers, config: RateLimitConfig, address?: string): string {
  if (config.trustedHeader) {
    const raw = headers.get(config.trustedHeader);
    const first = raw?.split(",")[0]?.trim();
    if (first) return first;
  }
  return address ?? "unknown";
}

/**
 * Fixed-window counter. Read-modify-write is not atomic, so two concurrent
 * requests can each read the same count and both be admitted. That slack is
 * bounded by the concurrency of a single window and is acceptable for a safety
 * limiter on one node. A Redis driver should implement this with `INCR` plus
 * `PEXPIRE` instead of `get`/`set`.
 */
export async function consume(
  cache: CounterCache,
  bucketKey: string,
  policy: RateLimitPolicy,
  nowMs: number,
): Promise<RateLimitDecision> {
  const windowStart = Math.floor(nowMs / policy.windowMs) * policy.windowMs;
  const resetAtMs = windowStart + policy.windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
  const key = `rl:${bucketKey}:${windowStart}`;

  const used = (await cache.get<number>(key)) ?? 0;
  if (used >= policy.limit) {
    return { allowed: false, limit: policy.limit, remaining: 0, retryAfterSeconds, resetAtMs };
  }

  // Do not extend the window on a denied request: the counter is only advanced by
  // admitted traffic, so a client that keeps hammering still gets in when it resets.
  await cache.set(key, used + 1, resetAtMs - nowMs);
  return {
    allowed: true,
    limit: policy.limit,
    remaining: policy.limit - used - 1,
    retryAfterSeconds,
    resetAtMs,
  };
}

export interface RateLimiter {
  config: RateLimitConfig;
  check(bucket: RateLimitBucket, headers: Headers, address?: string): Promise<RateLimitDecision>;
}

export interface RateLimiterOptions {
  cache: CounterCache;
  config: RateLimitConfig;
  /** Injectable clock. Request-time only, so wall-clock is fine in production. */
  now?: () => number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const now = options.now ?? (() => Date.now());
  return {
    config: options.config,
    async check(bucket, headers, address) {
      if (!options.config.enabled) return ALLOWED_UNLIMITED;
      const key = `${bucket}:${clientKey(headers, options.config, address)}`;
      return consume(options.cache, key, options.config[bucket], now());
    },
  };
}

/** The 429 body. The UI keys off the status, not this text. */
export const TOO_MANY_REQUESTS = "You are asking too quickly. Try again in a moment.";

export function rateLimitResponse(decision: RateLimitDecision): Response {
  return Response.json(
    { error: TOO_MANY_REQUESTS, retryAfterSeconds: decision.retryAfterSeconds },
    {
      status: 429,
      headers: {
        "retry-after": String(decision.retryAfterSeconds),
        "x-ratelimit-limit": String(decision.limit),
        "x-ratelimit-remaining": "0",
      },
    },
  );
}

/**
 * Hono middleware for one bucket. A null limiter is a pass-through, so a host that
 * fronts the app with its own edge limiter simply injects nothing.
 */
export function rateLimitMiddleware(
  limiter: RateLimiter | null,
  bucket: RateLimitBucket,
  address?: (request: Request) => string | undefined,
): MiddlewareHandler {
  return async (c, next) => {
    if (!limiter) return next();
    const decision = await limiter.check(bucket, c.req.raw.headers, address?.(c.req.raw));
    if (!decision.allowed) return rateLimitResponse(decision);
    await next();
  };
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(v)) return false;
  if (["1", "true", "on", "yes"].includes(v)) return true;
  return undefined;
}

/** `"10"` = 10 per minute. `"10/30"` = 10 per 30 seconds. Anything else is ignored. */
function parsePolicy(value: string | undefined, fallback: RateLimitPolicy): RateLimitPolicy {
  if (!value) return fallback;
  const [limitRaw, windowRaw] = value.split("/");
  const limit = Number.parseInt((limitRaw ?? "").trim(), 10);
  if (!Number.isInteger(limit) || limit <= 0) return fallback;
  if (windowRaw === undefined) return { limit, windowMs: 60_000 };
  const seconds = Number.parseInt(windowRaw.trim(), 10);
  if (!Number.isInteger(seconds) || seconds <= 0) return fallback;
  return { limit, windowMs: seconds * 1000 };
}

/**
 * Resolve limits from the operator's environment, over the site's `ai.limits`
 * block. Env wins: the person holding the key and the server is the one who
 * decides, and they may not control the docs repository. Throws on an invalid
 * `ai.limits` block, matching how the AI config fails fast.
 */
export function resolveRateLimitConfig(
  env: Record<string, string | undefined>,
  siteLimits?: unknown,
): RateLimitConfig {
  const base = rateLimitConfigSchema.parse(siteLimits ?? {});
  const trusted = env.READSMITH_TRUSTED_IP_HEADER?.trim();
  return {
    enabled: parseBool(env.READSMITH_RATE_LIMIT) ?? base.enabled,
    trustedHeader: trusted || base.trustedHeader,
    ask: parsePolicy(env.READSMITH_RATE_LIMIT_ASK, base.ask),
    search: parsePolicy(env.READSMITH_RATE_LIMIT_SEARCH, base.search),
    mcp: parsePolicy(env.READSMITH_RATE_LIMIT_MCP, base.mcp),
    exec: parsePolicy(env.READSMITH_RATE_LIMIT_EXEC, base.exec),
  };
}
