import { join } from "node:path";
import {
  createDb,
  createJobRunner,
  createLogger,
  hasDatabase,
  listenForDeploymentPublishes,
  loadDbConfig,
  migrationsDir,
  runMigrations,
} from "@readsmith/db";
import {
  createInProcessExecutor,
  createPoller,
  ensureGitConnection,
  invalidateAllBundleSources,
  runSiteBuild,
  siteBuildJob,
  siteBuildSingletonKey,
} from "@readsmith/git";
import { createBundleStore, resolveStorageConfig } from "@readsmith/storage";
import { getGitRuntime } from "./git.js";
import { embedIndexJob, indexBundle } from "./indexing.js";
import { invalidateSiteCache, resolveSiteUrl } from "./site.js";

/**
 * One-time backbone boot: run pending migrations, then start the job worker.
 * Imported only from the Node.js instrumentation branch, so this module (and its
 * Postgres dependencies) never reaches the edge bundle. The DB is optional; with
 * no DATABASE_URL this returns immediately and the app serves docs only.
 *
 * READSMITH_ROLE splits serving from building for multi-process deployments:
 * `serve` runs migrations and the pointer-freshness listener but registers no
 * job worker, so a heavy build never blocks the request event loop; `worker`
 * (or `all`, the default) runs the build/index worker and the git poller. A
 * single-box self-host leaves it unset and keeps both in one process.
 */
export async function boot(): Promise<void> {
  if (!hasDatabase()) return;

  const config = loadDbConfig();
  const log = createLogger(config.logLevel);
  const role = (process.env.READSMITH_ROLE ?? "all").toLowerCase();
  const runsWorker = role !== "serve";

  try {
    const db = createDb(config);
    const dir = process.env.READSMITH_MIGRATIONS_DIR ?? migrationsDir();
    const applied = await runMigrations(db, { dir, logger: log });
    log.info("database ready", { migrationsApplied: applied.length });

    // Cross-instance pointer freshness: another instance's publish or rollback
    // NOTIFYs, and every bundle source in this process (both module graphs)
    // drops that site's pointer cache immediately instead of waiting out the
    // TTL. Best-effort: a lost connection reconnects, and TTL remains the floor.
    const listener = await listenForDeploymentPublishes(
      config,
      (siteId) => invalidateAllBundleSources(siteId),
      log,
    ).catch((err) => {
      log.warn("deployment listener unavailable; pointer TTL only", { err: String(err) });
      return null;
    });
    (globalThis as { __rsDeploymentListener?: unknown }).__rsDeploymentListener = listener;

    // A serve-role instance stops here: it resolves and serves published
    // bundles, but never picks up a build. Building lives in the worker role.
    if (!runsWorker) {
      log.info("serve role: job worker disabled", { role });
      return;
    }

    const runner = createJobRunner({ config, logger: log });
    await runner.start();
    // Re-index the served bundle on demand (enqueued after every publish;
    // `pnpm ai:index` is the inline path for v1 self-host).
    await runner.work(embedIndexJob, async (payload) => {
      await indexBundle(db, payload.siteId ?? "default");
    });

    // Git-driven deployments: register the build handler and bind the
    // configured repo (which auto-builds a site with no deployment history).
    const jobs = ["embed.index"];
    const git = getGitRuntime();
    if (git) {
      const store = createBundleStore(
        resolveStorageConfig(process.env, join(process.cwd(), ".readsmith")),
      );
      const executor = createInProcessExecutor({ provider: git.provider, store });
      // Rollback history kept per site; older snapshots are pruned after each
      // publish (their artifacts too, when no live deployment shares them).
      const keepRaw = Number(process.env.READSMITH_KEEP_DEPLOYMENTS ?? "20");
      const keepLast = Number.isInteger(keepRaw) && keepRaw >= 0 ? keepRaw : 20;
      const failOnError = ["1", "true", "yes"].includes(
        (process.env.READSMITH_FAIL_ON_ERROR ?? "").toLowerCase(),
      );
      // Wall-clock budget per build; a hosted operator can tighten it to bound
      // how long one tenant's build occupies the worker. Falsy/invalid = default.
      const timeoutRaw = Number(process.env.READSMITH_BUILD_TIMEOUT_SEC);
      const timeoutSec = Number.isInteger(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : undefined;
      await runner.work(siteBuildJob, async (payload) => {
        await runSiteBuild(
          {
            db,
            store,
            executor,
            logger: log,
            retention: { keepLast },
            failOnError,
            timeoutSec,
            resolveSiteUrl,
            afterFlip: async (row) => {
              // This graph's pointer cache re-resolves immediately (the routes'
              // copy follows via TTL + revalidation), then search converges.
              invalidateSiteCache();
              await runner.enqueue(embedIndexJob, { siteId: row.site_id });
            },
          },
          payload,
        );
      });
      jobs.push("site.build");
      // The polling fallback: for self-hosts webhooks cannot reach. Idempotent
      // against webhook delivery (the singleton key dedupes).
      if (git.config.pollIntervalSec) {
        const poller = createPoller({
          db,
          provider: git.provider,
          logger: log,
          enqueue: (p) =>
            runner.enqueue(siteBuildJob, p, { singletonKey: siteBuildSingletonKey(p) }),
        });
        poller.start(git.config.pollIntervalSec);
        (globalThis as { __rsGitPoller?: unknown }).__rsGitPoller = poller;
        log.info("git polling enabled", { intervalSec: git.config.pollIntervalSec });
      }
      if (git.config.repo) {
        try {
          await ensureGitConnection(
            {
              db,
              provider: git.provider,
              enqueue: (p) =>
                runner.enqueue(siteBuildJob, p, { singletonKey: siteBuildSingletonKey(p) }),
              logger: log,
            },
            { siteId: "default", repo: git.config.repo, branch: git.config.branch },
          );
        } catch (err) {
          log.error("git connection bind failed; builds remain push-driven", {
            err: String(err),
          });
        }
      }
    }

    log.info("job runner started", {
      concurrency: config.workerConcurrency,
      jobs,
    });
    // Hold a reference so the runner is not garbage-collected.
    (globalThis as { __rsJobRunner?: unknown }).__rsJobRunner = runner;
  } catch (err) {
    log.error("database boot failed; serving docs-only", { err: String(err) });
  }
}
