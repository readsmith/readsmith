import { type RateLimiter, createRateLimiter, resolveRateLimitConfig } from "@readsmith/api";
import { createCache, resolveCacheConfig } from "@readsmith/cache";
import { getSite } from "./site.js";

/**
 * The process-wide rate limiter, shared by the JSON API and the MCP endpoint so both
 * count against one store. Server-only, memoized.
 *
 * It rides the cache port: the in-memory driver is correct for single-instance
 * self-host, and switching `CACHE_DRIVER` to a shared store makes the limiter
 * cluster-wide with no change here. Counters get their own cache instance so a
 * burst of query embeddings cannot evict them.
 */

/** `ai.limits` from docs.yaml, read raw: the AI config schema does not own it. */
function siteLimits(ai: unknown): unknown {
  if (ai && typeof ai === "object" && "limits" in ai) {
    return (ai as { limits?: unknown }).limits;
  }
  return undefined;
}

async function build(): Promise<RateLimiter> {
  // A multi-site host has no local default bundle; env-configured limits apply.
  const site = await getSite().catch(() => null);
  const cacheConfig = resolveCacheConfig(process.env);
  return createRateLimiter({
    cache: createCache(
      cacheConfig.driver === "memory" ? { ...cacheConfig, max: 10_000 } : cacheConfig,
    ),
    config: resolveRateLimitConfig(process.env, siteLimits(site?.ai)),
  });
}

let cached: Promise<RateLimiter> | undefined;

export function getRateLimiter(): Promise<RateLimiter> {
  if (!cached) cached = build();
  return cached;
}
