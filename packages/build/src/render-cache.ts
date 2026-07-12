import type { RenderCache, RenderResult } from "@readsmith/mdx";
import type { BundleStore } from "@readsmith/storage";
import { z } from "zod";

/**
 * The persisted render cache: P7's in-process, dependency-aware page cache made
 * durable through the artifact store, so a rebuild pays only for what changed
 * even across processes and deployments. Entries are content-addressed by the
 * page cacheKey (source + variables + theme + base path + used-snippet
 * hashes), which is
 * why reuse is safe: a shared-snippet edit changes every dependent page's key,
 * an unrelated edit changes only its own. The cache is best-effort by
 * construction; a missing, corrupt, or unwritable entry only costs a render.
 */
export const RENDER_CACHE_PREFIX = "render/";

/** Loose persistence guard: enough to reject corruption, not a domain schema. */
const persistedRenderResult = z.object({
  html: z.string(),
  hydration: z.unknown(),
  diagnostics: z.array(z.unknown()),
  cacheable: z.boolean(),
});

export interface PersistedRenderCache {
  /** The synchronous facade `compileSite` (and assembly under it) consumes. */
  cache: RenderCache;
  /** Write entries rendered this build back to the store; returns how many. */
  flush(): Promise<number>;
  stats(): { preloaded: number; hits: number; misses: number };
}

/**
 * Preload every cached render under `prefix` into memory and hand back a
 * sync cache plus a flush. Preloading keeps the render loop synchronous (the
 * cache contract) at the cost of reading the working set up front; entries are
 * per-page and small, and a docs-scale set is a few megabytes.
 */
export async function openRenderCache(
  store: BundleStore,
  options: { prefix?: string } = {},
): Promise<PersistedRenderCache> {
  const prefix = options.prefix ?? RENDER_CACHE_PREFIX;
  const entries = new Map<string, RenderResult>();
  const keys = await store.list(prefix);
  for (const key of keys) {
    const bytes = await store.get(key);
    if (!bytes) continue;
    try {
      const parsed = persistedRenderResult.parse(JSON.parse(bytes.toString("utf8")));
      entries.set(key.slice(prefix.length).replace(/\.json$/, ""), parsed as RenderResult);
    } catch {
      // A corrupt entry is just a miss; the page renders and overwrites it.
    }
  }

  const fresh = new Map<string, RenderResult>();
  let hits = 0;
  let misses = 0;
  const cache: RenderCache = {
    get(key) {
      const value = entries.get(key);
      if (value) hits += 1;
      else misses += 1;
      return value;
    },
    set(key, value) {
      if (!value.cacheable) return;
      entries.set(key, value);
      fresh.set(key, value);
    },
  };

  return {
    cache,
    async flush(): Promise<number> {
      for (const [key, value] of fresh) {
        await store.put(`${prefix}${key}.json`, JSON.stringify(value));
      }
      const wrote = fresh.size;
      fresh.clear();
      return wrote;
    },
    stats: () => ({ preloaded: keys.length, hits, misses }),
  };
}
