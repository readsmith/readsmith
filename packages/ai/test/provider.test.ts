import { describe, expect, it } from "vitest";
import {
  type AiConfig,
  MissingKeyError,
  ModelNotConfiguredError,
  chainKeySources,
  createMockProvider,
  createModelProvider,
  describeCapabilities,
  envKeySource,
  fakeEmbedding,
  resolveAiConfig,
} from "../src/index.js";

const cfg = (over: Partial<Record<string, unknown>> = {}): AiConfig => {
  const c = resolveAiConfig({
    chat: { provider: "openai", model: "gpt-x" },
    embedding: { provider: "openai", model: "text-embedding-3-small" },
    ...over,
  });
  if (!c) throw new Error("config");
  return c;
};

describe("BYOK key resolution", () => {
  it("prefers a role-specific env var over the provider-native one", () => {
    const src = envKeySource({ READSMITH_AI_CHAT_KEY: "role-key", OPENAI_API_KEY: "native-key" });
    expect(src.resolve("openai", "chat")).toBe("role-key");
    expect(src.resolve("openai", "embedding")).toBe("native-key");
    expect(src.resolve("openai", "rerank")).toBe("native-key");
  });

  it("returns null when no key is set", () => {
    expect(envKeySource({}).resolve("openai", "chat")).toBeNull();
  });

  it("resolves the gateway key from AI_GATEWAY_API_KEY", () => {
    const src = envKeySource({ AI_GATEWAY_API_KEY: "gw-key" });
    expect(src.resolve("gateway", "chat")).toBe("gw-key");
    expect(src.resolve("gateway", "embedding")).toBe("gw-key");
  });

  it("chains sources, first non-null wins (site key over env)", () => {
    const site = { resolve: (p: string) => (p === "openai" ? "site-key" : null) } as never;
    const chained = chainKeySources(site, envKeySource({ OPENAI_API_KEY: "env-key" }));
    expect(chained.resolve("openai", "chat")).toBe("site-key");
    expect(chained.resolve("google", "chat")).toBeNull();
  });
});

describe("model provider (real, ai-sdk backed)", () => {
  it("reports capabilities from config + resolvable keys", () => {
    const withKey = createModelProvider(cfg(), envKeySource({ OPENAI_API_KEY: "k" }));
    expect(withKey.hasChat()).toBe(true);
    expect(withKey.hasEmbedding()).toBe(true);

    const noKey = createModelProvider(cfg(), envKeySource({}));
    expect(noKey.hasChat()).toBe(false);
    expect(noKey.hasEmbedding()).toBe(false);
  });

  it("constructs a chat model when keyed, throws typed errors when not", async () => {
    const keyed = createModelProvider(cfg(), envKeySource({ OPENAI_API_KEY: "k" }));
    expect(keyed.chat()).toBeDefined();

    const unkeyed = createModelProvider(cfg(), envKeySource({}));
    expect(() => unkeyed.chat()).toThrow(MissingKeyError);
    await expect(unkeyed.embedMany(["x"])).rejects.toBeInstanceOf(MissingKeyError);

    const noChat = createModelProvider(
      cfg({ chat: undefined }),
      envKeySource({ OPENAI_API_KEY: "k" }),
    );
    expect(() => noChat.chat()).toThrow(ModelNotConfiguredError);
  });

  it("describes the degradation rung: embed-only vs full", () => {
    const embedOnly = cfg({ chat: undefined });
    const provider = createModelProvider(embedOnly, envKeySource({ OPENAI_API_KEY: "k" }));
    const caps = describeCapabilities(provider, embedOnly);
    expect(caps.embedding).toBe(true);
    expect(caps.chat).toBe(false);
    expect(caps.rerank).toBe(false);
  });
});

describe("mock provider", () => {
  it("produces a stable, normalized 1024-dim embedding", () => {
    const a = fakeEmbedding("hello");
    const b = fakeEmbedding("hello");
    expect(a).toHaveLength(1024);
    expect(a).toEqual(b);
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1);
  });

  it("embedMany runs the real ai-sdk embedMany and returns 1024-dim vectors", async () => {
    const provider = createMockProvider();
    const vectors = await provider.embedMany(["hello world", "second"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(1024);
    expect(vectors[0]).toEqual(fakeEmbedding("hello world"));
  });
});
