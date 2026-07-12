import { type Db, type Logger, getGitConnection, listDeployments } from "@readsmith/db";
import type { GitHubProvider } from "./github.js";
import type { SiteBuildPayload } from "./site-build.js";

/**
 * The polling fallback for self-hosts the provider cannot reach (no inbound
 * webhook path: firewalls, laptops, air-gapped-ish networks). One API call per
 * tick compares the connected branch head to what was last built; a change
 * enqueues the same idempotent, superseding `site.build` a webhook would.
 * Polling and webhooks coexist safely: the singleton key dedupes.
 */
export type PollOutcome = "queued" | "unchanged" | "no-connection" | "error";

export interface PollerDeps {
  db: Db;
  provider: GitHubProvider;
  enqueue: (payload: SiteBuildPayload) => Promise<unknown>;
  siteId?: string;
  logger?: Logger;
}

export interface Poller {
  /** One poll tick, exposed for tests and manual runs. */
  checkOnce(): Promise<PollOutcome>;
  start(intervalSec: number): void;
  stop(): void;
}

export function createPoller(deps: PollerDeps): Poller {
  const siteId = deps.siteId ?? "default";
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;

  async function checkOnce(): Promise<PollOutcome> {
    try {
      const connection = await getGitConnection(deps.db, siteId);
      if (!connection) return "no-connection";
      const resolved = await deps.provider.resolveBranch(
        { repo: connection.repo, installationId: connection.installation_id },
        connection.branch,
      );
      if (resolved.headSha === connection.last_synced_sha) return "unchanged";
      // A deployment for this head already exists (building, ready, or failed):
      // do not re-enqueue. This keeps a deterministically-failing commit from
      // hot-looping; the next push (or a manual trigger) moves things forward.
      const latest = await listDeployments(deps.db, { siteId, limit: 1 });
      if (latest[0]?.commit_sha === resolved.headSha) return "unchanged";
      await deps.enqueue({
        siteId,
        repo: connection.repo,
        ref: `refs/heads/${resolved.branch}`,
        commitSha: resolved.headSha,
      });
      deps.logger?.info("poll found a new head", {
        repo: connection.repo,
        commit: resolved.headSha,
      });
      return "queued";
    } catch (err) {
      deps.logger?.warn("poll tick failed", { err: String(err) });
      return "error";
    }
  }

  return {
    checkOnce,
    start(intervalSec: number): void {
      if (timer) return;
      timer = setInterval(async () => {
        if (inFlight) return; // never stack slow ticks
        inFlight = true;
        try {
          await checkOnce();
        } finally {
          inFlight = false;
        }
      }, intervalSec * 1000);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
