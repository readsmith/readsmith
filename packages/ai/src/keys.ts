/**
 * BYOK key resolution. Keys live only in env/secrets, never in `docs.yaml` and
 * never in the browser. Resolution is server-side, precedence first-hit-wins:
 * site/tenant (hosted seam) then operator/env. v1 ships the env source; the host
 * chains a site-key source in front for the hosted phase.
 */

export type ModelRole = "chat" | "embedding" | "rerank";

export interface KeySource {
  /** Resolve the API key for a provider in a role, or null. Never logs the key. */
  resolve(provider: string, role: ModelRole): string | null;
}

const ROLE_ENV: Record<ModelRole, string> = {
  chat: "READSMITH_AI_CHAT_KEY",
  embedding: "READSMITH_AI_EMBEDDING_KEY",
  rerank: "READSMITH_AI_RERANK_KEY",
};

const PROVIDER_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

/**
 * Env-based BYOK: a role-specific override (`READSMITH_AI_CHAT_KEY` ...) wins,
 * else the provider-native variable (`OPENAI_API_KEY` ...). This is the self-host
 * default; one key per configured provider is enough.
 */
export function envKeySource(env: Record<string, string | undefined> = process.env): KeySource {
  return {
    resolve(provider, role) {
      const roleKey = env[ROLE_ENV[role]];
      if (roleKey) return roleKey;
      const providerVar = PROVIDER_ENV[provider];
      const providerKey = providerVar ? env[providerVar] : undefined;
      return providerKey ?? null;
    },
  };
}

/** Chain key sources, first non-null wins (site/tenant in front of env, hosted). */
export function chainKeySources(...sources: readonly KeySource[]): KeySource {
  return {
    resolve(provider, role) {
      for (const source of sources) {
        const key = source.resolve(provider, role);
        if (key) return key;
      }
      return null;
    },
  };
}
