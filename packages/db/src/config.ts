import { z } from "zod";

/**
 * Database + backbone configuration, resolved from the environment. `DATABASE_URL`
 * is the single required knob; everything else defaults sanely so a self-host
 * operator sets one variable. Presence of `DATABASE_URL` is what activates the
 * whole persistence layer; without it the app runs docs-only (no DB, no worker).
 */
const dbConfigSchema = z.object({
  databaseUrl: z.string().min(1),
  /** Filesystem root for the storage abstraction (large JSON blobs). */
  storageRoot: z.string().default(".readsmith/storage"),
  /** pg-boss worker concurrency. Conservative default for self-host. */
  workerConcurrency: z.coerce.number().int().positive().default(2),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type DbConfig = z.infer<typeof dbConfigSchema>;

/** True when the environment has a database configured (backbone activated). */
export function hasDatabase(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.DATABASE_URL === "string" && env.DATABASE_URL.length > 0;
}

/**
 * Load and validate config from the environment. Throws a clear, secret-free
 * error when `DATABASE_URL` is missing so misconfiguration fails fast at boot.
 */
export function loadDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  if (!hasDatabase(env)) {
    throw new Error(
      "DATABASE_URL is required to use the persistence backbone but was not set. " +
        "Set it in your environment (see .env.example), or run docs-only without it.",
    );
  }
  return dbConfigSchema.parse({
    databaseUrl: env.DATABASE_URL,
    storageRoot: env.READSMITH_STORAGE_ROOT,
    workerConcurrency: env.READSMITH_WORKER_CONCURRENCY,
    logLevel: env.READSMITH_LOG_LEVEL,
  });
}
