import {
  createDb,
  createJobRunner,
  createLogger,
  hasDatabase,
  loadDbConfig,
  migrationsDir,
  runMigrations,
} from "@readsmith/db";
import { embedIndexJob, indexBundle } from "./indexing";

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
    // Re-index the compiled bundle on demand (the M2 GitHub App enqueues this on
    // publish; `pnpm ai:index` is the inline path for v1 self-host).
    await runner.work(embedIndexJob, async () => {
      await indexBundle(db);
    });
    log.info("job runner started", {
      concurrency: config.workerConcurrency,
      jobs: ["embed.index"],
    });
    // Hold a reference so the runner is not garbage-collected.
    (globalThis as { __rsJobRunner?: unknown }).__rsJobRunner = runner;
  } catch (err) {
    log.error("database boot failed; serving docs-only", { err: String(err) });
  }
}
