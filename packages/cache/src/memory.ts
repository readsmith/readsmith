import type { Cache } from "./port.js";

/**
 * An in-process LRU + TTL cache. LRU is via `Map` insertion order (a read or
 * write moves a key to the end; eviction drops from the front on overflow). The
 * clock is injectable so TTL expiry is testable without wall-clock waits.
 */
export interface MemoryCacheOptions {
  /** Max entries before least-recently-used eviction. */
  max?: number;
  /** Default TTL applied when `set` omits one. */
  defaultTtlMs?: number;
  /** Clock (default `Date.now`). Request-time only, so wall-clock is fine here. */
  now?: () => number;
}

interface Entry {
  value: unknown;
  expires: number;
}

export function createMemoryCache(options: MemoryCacheOptions = {}): Cache {
  const max = options.max ?? 500;
  const defaultTtl = options.defaultTtlMs ?? 60_000;
  const clock = options.now ?? (() => Date.now());
  const store = new Map<string, Entry>();

  const alive = (key: string): Entry | undefined => {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expires <= clock()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const entry = alive(key);
      if (!entry) return undefined;
      store.delete(key); // re-insert to mark most-recently-used
      store.set(key, entry);
      return entry.value as T;
    },
    async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
      store.delete(key);
      store.set(key, { value, expires: clock() + (ttlMs ?? defaultTtl) });
      while (store.size > max) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async clear(): Promise<void> {
      store.clear();
    },
  };
}
