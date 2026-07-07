import { type LanguageModel, embedMany } from "ai";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import { EMBEDDING_DIMENSIONS } from "./config.js";
import type { ModelProvider } from "./provider.js";

/**
 * A deterministic mock ModelProvider for tests: no network, no key. `embedMany`
 * runs the real ai-sdk `embedMany` against a mock embedding model that returns a
 * stable 1024-dim vector derived from the input text, so indexing and retrieval
 * tests are reproducible and exercise the real embedding wiring. Downstream
 * slices pass a scripted chat model for the Ask-AI agent.
 */

/** A stable, normalized 1024-dim embedding derived from text (no randomness). */
export function fakeEmbedding(text: string, dim: number = EMBEDDING_DIMENSIONS): number[] {
  const v = new Array<number>(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    const slot = i % dim;
    v[slot] = (v[slot] ?? 0) + ((text.charCodeAt(i) % 17) + 1) / 17;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export interface MockProviderOptions {
  /** Override the embedding function (default: `fakeEmbedding`). */
  embed?: (text: string) => number[];
  /** A scripted chat model (from `ai/test`) for Ask-AI tests. */
  chatModel?: LanguageModel;
  hasChat?: boolean;
  hasEmbedding?: boolean;
}

export function createMockProvider(opts: MockProviderOptions = {}): ModelProvider {
  const embed = opts.embed ?? ((t: string) => fakeEmbedding(t));
  const hasChat = opts.hasChat ?? true;
  const hasEmbedding = opts.hasEmbedding ?? true;

  const embeddingModel = new MockEmbeddingModelV4({
    provider: "mock",
    modelId: "mock-embed",
    maxEmbeddingsPerCall: 2048,
    doEmbed: async ({ values }) => ({ embeddings: values.map((v) => embed(v)), warnings: [] }),
  });

  const chatModel =
    opts.chatModel ??
    (new MockLanguageModelV4({
      provider: "mock",
      modelId: "mock-chat",
    }) as unknown as LanguageModel);

  return {
    hasChat: () => hasChat,
    hasEmbedding: () => hasEmbedding,
    chat: () => chatModel,
    async embedMany(texts) {
      if (texts.length === 0) return [];
      const { embeddings } = await embedMany({ model: embeddingModel, values: [...texts] });
      return embeddings;
    },
  };
}
