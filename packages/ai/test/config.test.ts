import { describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS, resolveAiConfig } from "../src/index.js";

describe("ai config", () => {
  it("returns null when no ai block is configured", () => {
    expect(resolveAiConfig(undefined)).toBeNull();
    expect(resolveAiConfig(null)).toBeNull();
  });

  it("applies sane defaults (rerank off, retention 90, bounds set)", () => {
    const cfg = resolveAiConfig({
      chat: { provider: "anthropic", model: "claude-sonnet-5" },
      embedding: { provider: "openai", model: "text-embedding-3-small" },
    });
    expect(cfg?.search.rrfK).toBe(60);
    expect(cfg?.askAi.enabled).toBe(true);
    expect(cfg?.askAi.maxSteps).toBe(4);
    expect(cfg?.analytics.retentionDays).toBe(90);
    expect(cfg?.rerank).toBeUndefined();
  });

  it("allows chat=anthropic with embedding=openai (independent providers)", () => {
    const cfg = resolveAiConfig({
      chat: { provider: "anthropic", model: "claude-sonnet-5" },
      embedding: { provider: "openai", model: "text-embedding-3-large" },
    });
    expect(cfg?.chat?.provider).toBe("anthropic");
    expect(cfg?.embedding?.provider).toBe("openai");
  });

  it("fails fast on an unknown provider, and rejects anthropic as an embedding provider", () => {
    expect(() => resolveAiConfig({ chat: { provider: "cohere", model: "x" } })).toThrow();
    expect(() => resolveAiConfig({ embedding: { provider: "anthropic", model: "x" } })).toThrow();
  });

  it("fixes the embedding dimension at 1024 (not configurable)", () => {
    expect(EMBEDDING_DIMENSIONS).toBe(1024);
    // A stray `dimension` in config is ignored (stripped), never honored.
    const cfg = resolveAiConfig({
      embedding: { provider: "openai", model: "text-embedding-3-small", dimension: 512 },
    });
    expect(cfg?.embedding).toEqual({ provider: "openai", model: "text-embedding-3-small" });
  });
});
