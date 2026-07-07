import {
  createDb,
  createJobRunner,
  createLogger,
  hasDatabase,
  loadDbConfig,
  migrationsDir,
  runMigrations,
} from "@readsmith/db";

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
    log.info("job runner started", { concurrency: config.workerConcurrency });
    // Job handlers (api.ingest) register when the ingest module lands; the runner
    // idles until then. Hold a reference so it is not garbage-collected.
    (globalThis as { __rsJobRunner?: unknown }).__rsJobRunner = runner;
  } catch (err) {
    log.error("database boot failed; serving docs-only", { err: String(err) });
  }
}
