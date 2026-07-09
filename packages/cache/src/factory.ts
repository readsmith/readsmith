import { createMemoryCache } from "./memory.js";
import {
  CACHE_DRIVERS,
  type Cache,
  type CacheConfig,
  CacheConfigError,
  cacheConfigSchema,
} from "./port.js";

/** Construct a Cache from validated config. One cache per process. */
export function createCache(config: CacheConfig): Cache {
  switch (config.driver) {
    case "memory":
      return createMemoryCache({ max: config.max, defaultTtlMs: config.defaultTtlMs });
    default: {
      const unreachable: never = config.driver;
      throw new CacheConfigError(`unsupported cache driver: ${String(unreachable)}`);
    }
  }
}

/** Environment shape the cache config is resolved from. */
export interface CacheEnv {
  CACHE_DRIVER?: string | undefined;
  [key: string]: string | undefined;
}

/**
 * Resolve cache config from environment, defaulting to the in-memory driver.
 * Fails fast on an unknown driver, naming the allowed values (matching the
 * storage driver's behaviour). Absent config is a no-op: it yields memory.
 */
export function resolveCacheConfig(env: CacheEnv = {}): CacheConfig {
  const driver = env.CACHE_DRIVER ?? "memory";
  if (!(CACHE_DRIVERS as readonly string[]).includes(driver)) {
    throw new CacheConfigError(
      `unknown CACHE_DRIVER "${driver}"; allowed: ${CACHE_DRIVERS.join(", ")}`,
    );
  }
  const parsed = cacheConfigSchema.safeParse({ driver });
  if (!parsed.success) {
    throw new CacheConfigError(
      `invalid cache config: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  return parsed.data;
}
