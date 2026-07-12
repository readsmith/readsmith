import {
  type Db,
  type GitConnectionRow,
  type Logger,
  listDeployments,
  listGitConnections,
} from "@readsmith/db";
import type { GitHubProvider } from "./github.js";
import type { SiteBuildPayload } from "./site-build.js";

/**
 * The polling fallback for installs the provider cannot reach (no inbound
 * webhook path: firewalls, laptops, air-gapped-ish networks). Each tick sweeps
 * every connected site: one API call per connection compares the branch head
 * to what was last built; a change enqueues the same idempotent, superseding
 * `site.build` a webhook would. Polling and webhooks coexist safely: the
 * singleton key dedupes. A single-site install sweeps its one connection,
 * exactly as before.
 */
export type PollOutcome = "queued" | "unchanged" | "error";

export interface PollResult {
  siteId: string;
  outcome: PollOutcome;
}

export interface PollerDeps {
  db: Db;
  provider: GitHubProvider;
  enqueue: (payload: SiteBuildPayload) => Promise<unknown>;
  logger?: Logger;
}

export interface Poller {
  /** One poll sweep over every connection, exposed for tests and manual runs. */
  checkOnce(): Promise<PollResult[]>;
  start(intervalSec: number): void;
  stop(): void;
}

export function createPoller(deps: PollerDeps): Poller {
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;

  async function checkConnection(connection: GitConnectionRow): Promise<PollOutcome> {
    try {
      const resolved = await deps.provider.resolveBranch(
        { repo: connection.repo, installationId: connection.installation_id },
        connection.branch,
      );
      if (resolved.headSha === connection.last_synced_sha) return "unchanged";
      // A deployment for this head already exists (building, ready, or failed):
      // do not re-enqueue. This keeps a deterministically-failing commit from
      // hot-looping; the next push (or a manual trigger) moves things forward.
      const latest = await listDeployments(deps.db, { siteId: connection.site_id, limit: 1 });
      if (latest[0]?.commit_sha === resolved.headSha) return "unchanged";
      await deps.enqueue({
        siteId: connection.site_id,
        repo: connection.repo,
        ref: `refs/heads/${resolved.branch}`,
        commitSha: resolved.headSha,
      });
      deps.logger?.info("poll found a new head", {
        site: connection.site_id,
        repo: connection.repo,
        commit: resolved.headSha,
      });
      return "queued";
    } catch (err) {
      deps.logger?.warn("poll tick failed", {
        site: connection.site_id,
        err: String(err),
      });
      return "error";
    }
  }

  async function checkOnce(): Promise<PollResult[]> {
    let connections: GitConnectionRow[];
    try {
      connections = await listGitConnections(deps.db);
    } catch (err) {
      deps.logger?.warn("poll sweep failed", { err: String(err) });
      return [];
    }
    // Sequential on purpose: a sweep is cheap (one API call per site) and
    // sequencing keeps a large install from bursting the provider's rate limit.
    const results: PollResult[] = [];
    for (const connection of connections) {
      results.push({ siteId: connection.site_id, outcome: await checkConnection(connection) });
    }
    return results;
  }

  return {
    checkOnce,
    start(intervalSec: number): void {
      if (timer) return;
      timer = setInterval(async () => {
        if (inFlight) return; // never stack slow sweeps
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
