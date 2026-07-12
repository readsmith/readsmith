import { join } from "node:path";
import {
  createDb,
  createJobRunner,
  createLogger,
  hasDatabase,
  loadDbConfig,
  migrationsDir,
  runMigrations,
} from "@readsmith/db";
import {
  createInProcessExecutor,
  ensureGitConnection,
  runSiteBuild,
  siteBuildJob,
  siteBuildSingletonKey,
} from "@readsmith/git";
import { createBundleStore, resolveStorageConfig } from "@readsmith/storage";
import { getGitRuntime } from "./git";
import { embedIndexJob, indexBundle } from "./indexing";
import { invalidateSiteCache } from "./site";

/**
 * One-time backbone boot: run pending migrations, then start the job worker.
 * Imported only from the Node.js instrumentation branch, so this module (and its
 * Postgres dependencies) never reaches the edge bundle. The DB is optional; with
 * no DATABASE_URL this returns immediately and the app serves docs only.
 */
export async function boot(): Promise<void> {
  if (!hasDatabase()) return;

  const config = loadDbConfig();
  const log = createLogger(config.logLevel);

  try {
    const db = createDb(config);
    const dir = process.env.READSMITH_MIGRATIONS_DIR ?? migrationsDir();
    const applied = await runMigrations(db, { dir, logger: log });
    log.info("database ready", { migrationsApplied: applied.length });

    const runner = createJobRunner({ config, logger: log });
    await runner.start();
    // Re-index the served bundle on demand (enqueued after every publish;
    // `pnpm ai:index` is the inline path for v1 self-host).
    await runner.work(embedIndexJob, async () => {
      await indexBundle(db);
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
      await runner.work(siteBuildJob, async (payload) => {
        await runSiteBuild(
          {
            db,
            store,
            executor,
            logger: log,
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
