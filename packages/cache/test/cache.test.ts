import { describe, expect, it } from "vitest";
import {
  CacheConfigError,
  createCache,
  createMemoryCache,
  resolveCacheConfig,
} from "../src/index.js";

describe("memory cache", () => {
  it("round-trips a value and reports a miss for an absent key", async () => {
    const cache = createMemoryCache();
    await cache.set("a", [1, 2, 3]);
    expect(await cache.get<number[]>("a")).toEqual([1, 2, 3]);
    expect(await cache.get("nope")).toBeUndefined();
  });

  it("expires entries by TTL (injected clock)", async () => {
    let t = 1000;
    const cache = createMemoryCache({ now: () => t });
    await cache.set("k", "v", 100);
    expect(await cache.get("k")).toBe("v");
    t = 1101; // past expiry
    expect(await cache.get("k")).toBeUndefined();
  });

  it("evicts the least-recently-used entry past the max", async () => {
    const cache = createMemoryCache({ max: 2 });
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.get("a"); // touch a -> b is now least-recently-used
    await cache.set("c", 3); // overflow evicts b
    expect(await cache.get("a")).toBe(1);
    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("c")).toBe(3);
  });

  it("deletes and clears", async () => {
    const cache = createMemoryCache();
    await cache.set("a", 1);
    await cache.delete("a");
    expect(await cache.get("a")).toBeUndefined();
    await cache.set("b", 2);
    await cache.clear();
    expect(await cache.get("b")).toBeUndefined();
  });
});

describe("cache config", () => {
  it("defaults to the memory driver", () => {
    expect(resolveCacheConfig({})).toEqual({ driver: "memory", max: 500, defaultTtlMs: 60_000 });
  });

  it("fails fast on an unknown driver, naming the allowed values", () => {
    let message = "";
    try {
      resolveCacheConfig({ CACHE_DRIVER: "redis" });
    } catch (err) {
      expect(err).toBeInstanceOf(CacheConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain("redis");
    expect(message).toContain("memory");
  });

  it("builds a working cache from resolved config", async () => {
    const cache = createCache(resolveCacheConfig({}));
    await cache.set("x", 1);
    expect(await cache.get("x")).toBe(1);
  });
});
