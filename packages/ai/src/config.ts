import { z } from "zod";

/**
 * The AI config block (from `docs.yaml`, resolved by the host and validated
 * here). Keys are NEVER in this shape - they come only from env/secrets. Absent
 * config = the AI surface is off. The embedding dimension is fixed (DM-2), so it
 * is deliberately not configurable.
 */

/**
 * Chat providers this build can construct. `gateway` is the Vercel AI Gateway
 * (one key, many models); its model ids are namespaced `provider/model`.
 */
export const chatProviders = ["openai", "anthropic", "google", "gateway"] as const;
/** Embedding providers. Anthropic has no first-party embeddings, so it is absent. */
export const embeddingProviders = ["openai", "google", "gateway"] as const;

export type ChatProvider = (typeof chatProviders)[number];
export type EmbeddingProvider = (typeof embeddingProviders)[number];

/** The fixed embedding dimension every model's output is normalized to (DM-2). */
export const EMBEDDING_DIMENSIONS = 1024;

const chatRefSchema = z.object({
  provider: z.enum(chatProviders),
  model: z.string().min(1),
});
const embeddingRefSchema = z.object({
  provider: z.enum(embeddingProviders),
  model: z.string().min(1),
});

export const aiConfigSchema = z.object({
  chat: chatRefSchema.optional(),
  embedding: embeddingRefSchema.optional(),
  rerank: z
    .object({
      provider: z.string().min(1),
      model: z.string().min(1),
      enabled: z.boolean().default(false),
    })
    .optional(),
  search: z
    .object({
      rrfK: z.number().int().positive().default(60),
      topK: z.number().int().positive().default(8),
    })
    .default({ rrfK: 60, topK: 8 }),
  askAi: z
    .object({
      enabled: z.boolean().default(true),
      maxSteps: z.number().int().positive().default(4),
      maxOutputTokens: z.number().int().positive().default(1024),
      timeoutMs: z.number().int().positive().default(30_000),
      /**
       * Optional owner guidance appended to the assistant's system prompt (voice,
       * tone, product vocabulary). It is framed as style/scope only and never
       * overrides the base rules (answer from the docs, cite sources, treat tool
       * output as untrusted).
       */
      instructions: z.string().optional(),
      /**
       * Restrict the assistant's retrieval to these top-level sections (a page
       * path's first segment). Empty/omitted = the whole site.
       */
      sections: z.array(z.string()).optional(),
    })
    .default({ enabled: true, maxSteps: 4, maxOutputTokens: 1024, timeoutMs: 30_000 }),
  analytics: z
    .object({ retentionDays: z.number().int().positive().default(90) })
    .default({ retentionDays: 90 }),
});
export type AiConfig = z.infer<typeof aiConfigSchema>;

/**
 * Resolve the AI config from the raw `ai` block (or undefined/null when absent).
 * Returns null when no AI is configured; throws (fail-fast) on an invalid block,
 * for example an unknown provider - the error names the allowed values.
 */
export function resolveAiConfig(raw: unknown): AiConfig | null {
  if (raw === undefined || raw === null) return null;
  return aiConfigSchema.parse(raw);
}
