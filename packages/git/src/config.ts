import type { GitHubAuth } from "./github.js";

/**
 * Git-integration env resolution. Absent credentials mean git is off (the app
 * runs docs-only / local-bundle); partial or conflicting credentials fail fast
 * with a message that names the variables and never echoes a value.
 */
export interface GitConfig {
  auth: GitHubAuth;
  webhookSecret: string | null;
  /** `owner/name` to bind at boot (CF-2 declarative bind); null = bind later. */
  repo: string | null;
  /** Branch override; null = the repo's default branch. */
  branch: string | null;
  /** Polling fallback interval, seconds; null = webhooks only. */
  pollIntervalSec: number | null;
}

export interface GitEnv {
  GITHUB_APP_ID?: string | undefined;
  GITHUB_APP_PRIVATE_KEY?: string | undefined;
  GITHUB_WEBHOOK_SECRET?: string | undefined;
  GITHUB_PAT?: string | undefined;
  GITHUB_REPO?: string | undefined;
  GITHUB_BRANCH?: string | undefined;
  GITHUB_POLL_INTERVAL?: string | undefined;
  [key: string]: string | undefined;
}

export class GitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitConfigError";
  }
}

/** Resolve config from env; null = git integration off (no credentials set). */
export function resolveGitConfig(env: GitEnv): GitConfig | null {
  const appId = env.GITHUB_APP_ID?.trim();
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  const pat = env.GITHUB_PAT?.trim();

  if ((appId || privateKey) && pat) {
    throw new GitConfigError(
      "configure either the GitHub App pair (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY) or GITHUB_PAT, not both",
    );
  }

  let auth: GitHubAuth | null = null;
  if (appId && privateKey) {
    // Keys pasted into env often carry literal \n escapes; normalize to PEM.
    auth = { kind: "app", appId, privateKey: privateKey.replace(/\\n/g, "\n") };
  } else if (appId || privateKey) {
    throw new GitConfigError("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set together");
  } else if (pat) {
    auth = { kind: "pat", token: pat };
  }

  if (!auth) {
    if (env.GITHUB_REPO) {
      throw new GitConfigError(
        "GITHUB_REPO is set but no GitHub credentials are configured (set the App pair or GITHUB_PAT)",
      );
    }
    return null;
  }

  let pollIntervalSec: number | null = null;
  if (env.GITHUB_POLL_INTERVAL !== undefined && env.GITHUB_POLL_INTERVAL.trim() !== "") {
    const parsed = Number(env.GITHUB_POLL_INTERVAL);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new GitConfigError("GITHUB_POLL_INTERVAL must be a positive integer (seconds)");
    }
    pollIntervalSec = parsed;
  }

  return {
    auth,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET ?? null,
    repo: env.GITHUB_REPO?.trim() || null,
    branch: env.GITHUB_BRANCH?.trim() || null,
    pollIntervalSec,
  };
}
