import PgBoss from "pg-boss";
import type { ZodType } from "zod";
import type { DbConfig } from "./config.js";
import type { Logger } from "./log.js";

/**
 * A typed job: a queue name plus the Zod schema its payload is validated against
 * at both enqueue and consume, so malformed work never reaches a handler. Retry
 * policy travels with the definition.
 */
export interface JobDefinition<T> {
  name: string;
  schema: ZodType<T>;
  retryLimit?: number;
  retryDelaySeconds?: number;
  retryBackoff?: boolean;
}

export function defineJob<T>(def: JobDefinition<T>): JobDefinition<T> {
  return def;
}

export interface JobRunner {
  /** Start the runner (creates the pg-boss schema on first run). */
  start(): Promise<void>;
  /**
   * Enqueue work. A `singletonKey` deduplicates: while a job with that key is
   * queued or active, a repeat enqueue is dropped (returns null), which is how
   * idempotent work (for example ingest of unchanged bytes) avoids double-runs.
   */
  enqueue<T>(
    job: JobDefinition<T>,
    data: T,
    opts?: { singletonKey?: string },
  ): Promise<string | null>;
  /** Register a handler for a job. Payload is re-validated before the handler runs. */
  work<T>(job: JobDefinition<T>, handler: (data: T) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  readonly boss: PgBoss;
}

/**
 * Create a pg-boss job runner on the same Postgres as everything else (no
 * separate broker: the self-host "zero external services" payoff). Handler
 * failures are logged and retried with bounded backoff; an exhausted job is a
 * logged diagnostic, never a crashed worker.
 */
export function createJobRunner(input: { config: DbConfig; logger?: Logger }): JobRunner {
  const { config, logger } = input;
  const boss = new PgBoss({ connectionString: config.databaseUrl });
  boss.on("error", (err) => logger?.error("job runner error", { err: String(err) }));

  return {
    boss,
    async start(): Promise<void> {
      await boss.start();
    },
    async enqueue(job, data, opts): Promise<string | null> {
      const payload = job.schema.parse(data) as object;
      const options: PgBoss.SendOptions = {
        retryLimit: job.retryLimit ?? 3,
        retryBackoff: job.retryBackoff ?? true,
        retryDelay: job.retryDelaySeconds ?? 5,
      };
      if (opts?.singletonKey !== undefined) options.singletonKey = opts.singletonKey;
      return boss.send(job.name, payload, options);
    },
    async work(job, handler): Promise<void> {
      await boss.work(
        job.name,
        { teamSize: config.workerConcurrency, newJobCheckInterval: 500 },
        async (raw) => {
          const data = job.schema.parse((raw as { data: unknown }).data);
          try {
            await handler(data);
          } catch (err) {
            logger?.error("job failed", { name: job.name, err: String(err) });
            throw err;
          }
        },
      );
    },
    async stop(): Promise<void> {
      await boss.stop({ graceful: false });
    },
  };
}
