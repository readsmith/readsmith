import type { AiConfig } from "./config.js";
import type { ModelProvider } from "./provider.js";

/**
 * Which AI capabilities are live given the configured providers + resolvable
 * keys. This is the provider half of the degradation ladder; the host combines
 * it with DB presence (no DB = docs-only) to decide which routes to expose.
 */
export interface AiCapabilities {
  /** Vector indexing + the vector arm of search (needs an embedding key). */
  embedding: boolean;
  /** Ask-AI (needs a chat key and askAi enabled). */
  chat: boolean;
  /** Reranking (opt-in, off by default). */
  rerank: boolean;
}

export function describeCapabilities(provider: ModelProvider, config: AiConfig): AiCapabilities {
  return {
    embedding: provider.hasEmbedding(),
    chat: provider.hasChat() && config.askAi.enabled,
    rerank: Boolean(config.rerank?.enabled),
  };
}
