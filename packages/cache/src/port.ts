import { z } from "zod";

/**
 * The cache port: a small async key/value store with per-entry TTL. Async so a
 * network-backed driver (Redis) fits the same interface as the in-memory LRU. It
 * is a cache, not a store: entries may vanish at any time (eviction, expiry), so
 * callers must treat a miss as normal and recompute.
 */
export interface Cache {
  /** Read a value, or undefined on miss/expiry. */
  get<T>(key: string): Promise<T | undefined>;
  /** Write a value with an optional TTL (falls back to the driver default). */
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  /** Drop a key. */
  delete(key: string): Promise<void>;
  /** Drop everything. */
  clear(): Promise<void>;
}

/** Driver names this build understands (v1: memory only). */
export const CACHE_DRIVERS = ["memory"] as const;

/** Driver config. A discriminated union so a Redis driver adds additively. */
export const cacheConfigSchema = z.discriminatedUnion("driver", [
  z.object({
    driver: z.literal("memory"),
    /** Max entries before LRU eviction. */
    max: z.number().int().positive().default(500),
    /** Default TTL when `set` omits one. */
    defaultTtlMs: z.number().int().positive().default(60_000),
  }),
]);
export type CacheConfig = z.infer<typeof cacheConfigSchema>;

/** Invalid cache configuration (for example an unknown driver name). */
export class CacheConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheConfigError";
  }
}
