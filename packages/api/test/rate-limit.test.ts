import { createMemoryCache } from "@readsmith/cache";
import { describe, expect, it } from "vitest";
import { createApiApp } from "../src/app.js";
import type { AiServices, ApiDatabase } from "../src/deps.js";
import {
  type CounterCache,
  DEFAULT_RATE_LIMITS,
  type RateLimitConfig,
  clientKey,
  consume,
  createRateLimiter,
  resolveRateLimitConfig,
} from "../src/rate-limit.js";

const okDb: ApiDatabase = { query: async () => [] };

function mockAi(): AiServices {
  return {
    capabilities: { search: true, vectorSearch: true, askAi: true },
    search: async () => ({ hits: [], degraded: false }),
    ask: async () =>
      new Response("data: hi\n\n", { headers: { "content-type": "text/event-stream" } }),
    feedback: async () => {},
    mcp: async () => new Response("{}"),
  };
}

/** A second, independent driver: proves the limiter talks only to the port (AC-2.4). */
function stubCache(): CounterCache {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return store.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T) {
      store.set(key, value);
    },
  };
}

function config(over: Partial<RateLimitConfig> = {}): RateLimitConfig {
  return { enabled: true, ...DEFAULT_RATE_LIMITS, ...over };
}

/** A frozen clock, so windows are exercised without wall-clock waits. */
function clockAt(start: number): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe("consume: fixed-window counter", () => {
  it("admits up to the limit, then denies", async () => {
    const cache = createMemoryCache({ now: () => 1_000 });
    const policy = { limit: 3, windowMs: 60_000 };
    const decisions = [];
    for (let i = 0; i < 4; i++) decisions.push(await consume(cache, "ask:1.2.3.4", policy, 1_000));

    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false]);
    expect(decisions.map((d) => d.remaining)).toEqual([2, 1, 0, 0]);
  });

  it("resets when the window rolls over", async () => {
    const clock = clockAt(0);
    const cache = createMemoryCache({ now: clock.now });
    const policy = { limit: 1, windowMs: 60_000 };

    expect((await consume(cache, "k", policy, clock.now())).allowed).toBe(true);
    expect((await consume(cache, "k", policy, clock.now())).allowed).toBe(false);

    clock.advance(60_000);
    expect((await consume(cache, "k", policy, clock.now())).allowed).toBe(true);
  });

  it("never reports Retry-After: 0", async () => {
    const cache = createMemoryCache({ now: () => 0 });
    const policy = { limit: 1, windowMs: 1_000 };
    await consume(cache, "k", policy, 0);
    // 1ms before the window closes: rounding must still yield at least one second.
    const denied = await consume(cache, "k", policy, 999);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("a denied request does not extend the window", async () => {
    const clock = clockAt(0);
    const cache = createMemoryCache({ now: clock.now });
    const policy = { limit: 1, windowMs: 10_000 };

    await consume(cache, "k", policy, 0);
    clock.advance(5_000);
    expect((await consume(cache, "k", policy, clock.now())).allowed).toBe(false); // hammering
    clock.advance(5_000); // the original window closes on schedule
    expect((await consume(cache, "k", policy, clock.now())).allowed).toBe(true);
  });

  // AC-2.4
  it("AC-2.4: is driver-agnostic", async () => {
    const policy = { limit: 2, windowMs: 60_000 };
    for (const cache of [createMemoryCache({ now: () => 0 }), stubCache()]) {
      const results = [];
      for (let i = 0; i < 3; i++) results.push((await consume(cache, "k", policy, 0)).allowed);
      expect(results).toEqual([true, true, false]);
    }
  });
});

describe("clientKey: who is the caller", () => {
  // AC-2.2
  it("AC-2.2: uses the trusted header when configured", () => {
    const cfg = config({ trustedHeader: "cf-connecting-ip" });
    const headers = new Headers({ "cf-connecting-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1" });
    expect(clientKey(headers, cfg, "10.0.0.1")).toBe("9.9.9.9");
  });

  it("takes the first hop of a comma-separated trusted header", () => {
    const cfg = config({ trustedHeader: "x-real-ip" });
    expect(clientKey(new Headers({ "x-real-ip": "9.9.9.9, 10.0.0.2" }), cfg)).toBe("9.9.9.9");
  });

  // AC-2.2
  it("AC-2.2: falls back to the socket address when no trusted header is set", () => {
    expect(clientKey(new Headers(), config(), "10.0.0.1")).toBe("10.0.0.1");
  });

  // AC-2.3: the whole point. X-Forwarded-For is client-settable, so honoring it by
  // default would let one attacker mint a fresh bucket per request.
  it("AC-2.3: never trusts X-Forwarded-For unless the operator names it", () => {
    const cfg = config(); // no trustedHeader
    const a = clientKey(new Headers({ "x-forwarded-for": "1.1.1.1" }), cfg);
    const b = clientKey(new Headers({ "x-forwarded-for": "2.2.2.2" }), cfg);
    expect(a).toBe(b); // same bucket: spoofing bought nothing
  });

  it("falls back to the socket address when the trusted header is absent", () => {
    const cfg = config({ trustedHeader: "cf-connecting-ip" });
    expect(clientKey(new Headers(), cfg, "10.0.0.1")).toBe("10.0.0.1");
  });
});

describe("createRateLimiter", () => {
  it("separates buckets per route and per client", async () => {
    const limiter = createRateLimiter({
      cache: createMemoryCache({ now: () => 0 }),
      config: config({ trustedHeader: "cf-connecting-ip", ask: { limit: 1, windowMs: 60_000 } }),
      now: () => 0,
    });
    const alice = new Headers({ "cf-connecting-ip": "1.1.1.1" });
    const bob = new Headers({ "cf-connecting-ip": "2.2.2.2" });

    expect((await limiter.check("ask", alice)).allowed).toBe(true);
    expect((await limiter.check("ask", alice)).allowed).toBe(false); // alice is done
    expect((await limiter.check("ask", bob)).allowed).toBe(true); // bob is unaffected
    expect((await limiter.check("search", alice)).allowed).toBe(true); // other bucket
  });

  // AC-2.6
  it("AC-2.6: admits everything when disabled", async () => {
    const limiter = createRateLimiter({
      cache: createMemoryCache(),
      config: config({ enabled: false, ask: { limit: 1, windowMs: 60_000 } }),
    });
    for (let i = 0; i < 5; i++) {
      expect((await limiter.check("ask", new Headers())).allowed).toBe(true);
    }
  });
});

describe("resolveRateLimitConfig", () => {
  it("defaults to on with the documented limits", () => {
    const cfg = resolveRateLimitConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.ask).toEqual({ limit: 10, windowMs: 60_000 });
    expect(cfg.search).toEqual({ limit: 60, windowMs: 60_000 });
    expect(cfg.mcp).toEqual({ limit: 60, windowMs: 60_000 });
  });

  it("reads the site's ai.limits block", () => {
    const cfg = resolveRateLimitConfig({}, { ask: { limit: 3, windowMs: 1_000 } });
    expect(cfg.ask).toEqual({ limit: 3, windowMs: 1_000 });
    expect(cfg.search).toEqual(DEFAULT_RATE_LIMITS.search); // untouched
  });

  it("lets the operator's env win over the site config", () => {
    const cfg = resolveRateLimitConfig(
      { READSMITH_RATE_LIMIT_ASK: "99/30", READSMITH_TRUSTED_IP_HEADER: "cf-connecting-ip" },
      { ask: { limit: 3, windowMs: 1_000 }, trustedHeader: "x-real-ip" },
    );
    expect(cfg.ask).toEqual({ limit: 99, windowMs: 30_000 });
    expect(cfg.trustedHeader).toBe("cf-connecting-ip");
  });

  it("reads a bare limit as per-minute", () => {
    expect(resolveRateLimitConfig({ READSMITH_RATE_LIMIT_ASK: "5" }).ask).toEqual({
      limit: 5,
      windowMs: 60_000,
    });
  });

  it("ignores a malformed env policy rather than opening the faucet", () => {
    for (const bad of ["0", "-1", "abc", "10/0", "10/x", ""]) {
      expect(resolveRateLimitConfig({ READSMITH_RATE_LIMIT_ASK: bad }).ask).toEqual(
        DEFAULT_RATE_LIMITS.ask,
      );
    }
  });

  // AC-2.6
  it("AC-2.6: can be disabled from the environment", () => {
    for (const off of ["0", "false", "off", "no"]) {
      expect(resolveRateLimitConfig({ READSMITH_RATE_LIMIT: off }).enabled).toBe(false);
    }
    expect(resolveRateLimitConfig({ READSMITH_RATE_LIMIT: "true" }).enabled).toBe(true);
  });

  it("fails fast on an invalid ai.limits block", () => {
    expect(() => resolveRateLimitConfig({}, { ask: { limit: -1, windowMs: 1 } })).toThrow();
  });
});

describe("createApiApp: rate limiting", () => {
  const post = (app: ReturnType<typeof createApiApp>, path: string, ip?: string) =>
    app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(ip ? { "cf-connecting-ip": ip } : {}),
      },
      body: JSON.stringify({ query: "x" }),
    });

  const appWith = (over: Partial<RateLimitConfig>) =>
    createApiApp({
      db: okDb,
      ai: mockAi(),
      rateLimit: createRateLimiter({
        cache: createMemoryCache({ now: () => 0 }),
        config: config({ trustedHeader: "cf-connecting-ip", ...over }),
        now: () => 0,
      }),
    });

  // AC-2.1
  it("AC-2.1: 429s past the limit, with Retry-After", async () => {
    const app = appWith({ ask: { limit: 1, windowMs: 60_000 } });
    expect((await post(app, "/api/ask", "1.1.1.1")).status).toBe(200);

    const denied = await post(app, "/api/ask", "1.1.1.1");
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBe("60");
    expect(denied.headers.get("x-ratelimit-limit")).toBe("1");
    expect(await denied.json()).toMatchObject({ retryAfterSeconds: 60 });
  });

  it("limits /api/search on its own bucket", async () => {
    const app = appWith({ search: { limit: 1, windowMs: 60_000 } });
    expect((await post(app, "/api/search", "1.1.1.1")).status).toBe(200);
    expect((await post(app, "/api/search", "1.1.1.1")).status).toBe(429);
    expect((await post(app, "/api/ask", "1.1.1.1")).status).toBe(200); // ask is untouched
  });

  // AC-2.3 at the route level
  it("AC-2.3: a spoofed X-Forwarded-For cannot mint a fresh bucket", async () => {
    const app = createApiApp({
      db: okDb,
      ai: mockAi(),
      rateLimit: createRateLimiter({
        cache: createMemoryCache({ now: () => 0 }),
        config: config({ ask: { limit: 2, windowMs: 60_000 } }), // no trustedHeader
        now: () => 0,
      }),
    });
    const attempt = (xff: string) =>
      app.request("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": xff },
        body: JSON.stringify({ query: "x" }),
      });

    expect((await attempt("1.1.1.1")).status).toBe(200);
    expect((await attempt("2.2.2.2")).status).toBe(200);
    expect((await attempt("3.3.3.3")).status).toBe(429); // shared bucket held
  });

  it("passes everything through when no limiter is injected", async () => {
    const app = createApiApp({ db: okDb, ai: mockAi() });
    for (let i = 0; i < 20; i++) expect((await post(app, "/api/ask")).status).toBe(200);
  });
});
