import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { type LanguageModel, embedMany } from "ai";
import { type AiConfig, EMBEDDING_DIMENSIONS, type EmbeddingProvider } from "./config.js";
import { MissingKeyError, ModelNotConfiguredError } from "./errors.js";
import type { KeySource } from "./keys.js";

/**
 * The provider port: the capability surface the rest of the package uses, over
 * ai-sdk. Chat and embedding are independently keyed (a real combo is
 * chat=Anthropic + embedding=OpenAI). `embedMany` normalizes every provider's
 * output to `EMBEDDING_DIMENSIONS` (1024, DM-2), so the doc_chunks halfvec column
 * always matches; `chat` hands back the raw language model for the agent loop.
 */
export interface ModelProvider {
  /** Whether a chat model is both configured and has a resolvable key. */
  hasChat(): boolean;
  /** Whether an embedding model is both configured and has a resolvable key. */
  hasEmbedding(): boolean;
  /** Embed texts, normalized to 1024 dims, in provider-batched calls. */
  embedMany(texts: readonly string[]): Promise<number[][]>;
  /** The chat model for the Ask-AI agent. Throws if unconfigured or unkeyed. */
  chat(): LanguageModel;
}

/** Per-provider option to force the 1024-dim output (Matryoshka truncation). */
function embeddingProviderOptions(
  provider: EmbeddingProvider,
): Record<string, Record<string, number>> {
  switch (provider) {
    case "openai":
      return { openai: { dimensions: EMBEDDING_DIMENSIONS } };
    case "google":
      return { google: { outputDimensionality: EMBEDDING_DIMENSIONS } };
  }
}

/** Build the real, ai-sdk-backed provider from validated config + a key source. */
export function createModelProvider(config: AiConfig, keys: KeySource): ModelProvider {
  return {
    hasChat() {
      return Boolean(config.chat && keys.resolve(config.chat.provider, "chat"));
    },
    hasEmbedding() {
      return Boolean(config.embedding && keys.resolve(config.embedding.provider, "embedding"));
    },
    async embedMany(texts): Promise<number[][]> {
      const ref = config.embedding;
      if (!ref) throw new ModelNotConfiguredError("embedding");
      const apiKey = keys.resolve(ref.provider, "embedding");
      if (!apiKey) throw new MissingKeyError(ref.provider);
      if (texts.length === 0) return [];
      const model =
        ref.provider === "openai"
          ? createOpenAI({ apiKey }).textEmbeddingModel(ref.model)
          : createGoogleGenerativeAI({ apiKey }).textEmbeddingModel(ref.model);
      const { embeddings } = await embedMany({
        model,
        values: [...texts],
        providerOptions: embeddingProviderOptions(ref.provider),
        maxRetries: 3,
      });
      return embeddings;
    },
    chat(): LanguageModel {
      const ref = config.chat;
      if (!ref) throw new ModelNotConfiguredError("chat");
      const apiKey = keys.resolve(ref.provider, "chat");
      if (!apiKey) throw new MissingKeyError(ref.provider);
      switch (ref.provider) {
        case "openai":
          return createOpenAI({ apiKey }).languageModel(ref.model);
        case "anthropic":
          return createAnthropic({ apiKey }).languageModel(ref.model);
        case "google":
          return createGoogleGenerativeAI({ apiKey }).languageModel(ref.model);
      }
    },
  };
}
