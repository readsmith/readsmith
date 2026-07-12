import type { GitService } from "@readsmith/api";
import {
  type JobRunner,
  createJobRunner,
  createLogger,
  hasDatabase,
  loadDbConfig,
} from "@readsmith/db";
import {
  type GitConfig,
  type GitHubProvider,
  type SiteBuildPayload,
  createGitHubProvider,
  createWebhookHandler,
  resolveGitConfig,
  siteBuildJob,
  siteBuildSingletonKey,
} from "@readsmith/git";
import { getDb } from "./db";

/**
 * Server-only composition of the git integration. Config resolves once from
 * env; absent credentials mean the whole surface is null and the app behaves
 * exactly as before (docs-only / local bundle). A misconfiguration (partial App
 * pair, App pair plus PAT) logs loudly and disables git rather than taking the
 * app down: serving content beats serving errors.
 */
export interface GitRuntime {
  config: GitConfig;
  provider: GitHubProvider;
}

let runtime: GitRuntime | null | undefined;

export function getGitRuntime(): GitRuntime | null {
  if (runtime === undefined) {
    try {
      const config = resolveGitConfig(process.env);
      runtime = config ? { config, provider: createGitHubProvider({ auth: config.auth }) } : null;
    } catch (err) {
      console.error(`[readsmith] git integration disabled: ${String(err)}`);
      runtime = null;
    }
  }
  return runtime;
}

/**
 * A lazily-started pg-boss sender for the webhook path (the worker lives in the
 * boot instrumentation; route handlers only enqueue). Multiple pg-boss
 * instances on one database are fine; this one never registers handlers.
 */
let senderPromise: Promise<JobRunner> | undefined;

function getSender(): Promise<JobRunner> {
  if (!senderPromise) {
    const config = loadDbConfig();
    const runner = createJobRunner({ config, logger: createLogger(config.logLevel) });
    senderPromise = runner.start().then(() => runner);
  }
  return senderPromise;
}

export async function enqueueSiteBuild(payload: SiteBuildPayload): Promise<unknown> {
  const runner = await getSender();
  return runner.enqueue(siteBuildJob, payload, { singletonKey: siteBuildSingletonKey(payload) });
}

let service: GitService | null | undefined;

/** The webhook surface injected into the API app; null when git is off. */
export function getGitService(): GitService | null {
  if (service === undefined) {
    const rt = getGitRuntime();
    if (!rt || !hasDatabase()) {
      service = null;
    } else {
      const handler = createWebhookHandler({
        db: getDb(),
        secret: rt.config.webhookSecret,
        enqueue: enqueueSiteBuild,
        logger: createLogger(loadDbConfig().logLevel),
      });
      service = { webhook: handler };
    }
  }
  return service;
}
