import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { EmbeddingModel, LanguageModel } from "ai";
import type { AiConfig } from "./config.js";
import { MissingKeyError, ModelNotConfiguredError } from "./errors.js";
import type { KeySource } from "./keys.js";

/**
 * The provider port: resolves ai-sdk model instances for the three roles from
 * config + a key source. Chat, embedding, and rerank are independently keyed (a
 * real combo is chat=Anthropic + embedding=OpenAI). The rest of the package
 * speaks only ai-sdk types, so swapping providers is config, not code.
 */
export interface ModelProvider {
  /** Whether a chat model is both configured and has a resolvable key. */
  hasChat(): boolean;
  /** Whether an embedding model is both configured and has a resolvable key. */
  hasEmbedding(): boolean;
  /** The chat model. Throws if unconfigured or unkeyed. */
  chat(): LanguageModel;
  /** The embedding model. Throws if unconfigured or unkeyed. */
  embedding(): EmbeddingModel;
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
    embedding(): EmbeddingModel {
      const ref = config.embedding;
      if (!ref) throw new ModelNotConfiguredError("embedding");
      const apiKey = keys.resolve(ref.provider, "embedding");
      if (!apiKey) throw new MissingKeyError(ref.provider);
      switch (ref.provider) {
        case "openai":
          return createOpenAI({ apiKey }).textEmbeddingModel(ref.model);
        case "google":
          return createGoogleGenerativeAI({ apiKey }).textEmbeddingModel(ref.model);
      }
    },
  };
}
