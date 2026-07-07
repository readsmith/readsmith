import pg from "pg";
import type { DbConfig } from "./config.js";
import type { SqlQuery } from "./sql.js";

/**
 * An error crossing the persistence boundary. Carries the Postgres error code and
 * the (value-free) statement text for diagnosis, and deliberately NOT the bound
 * values or row contents, so secrets never travel in an error message.
 */
export class DbError extends Error {
  readonly code: string | undefined;
  constructor(message: string, options: { code?: string; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "DbError";
    this.code = options.code;
  }
}

/** The minimal query surface a Pool and a checked-out client both satisfy. */
interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<pg.QueryResult>;
}

export interface Db {
  /** Run a parameterized query and return its rows. */
  query<T = Record<string, unknown>>(q: SqlQuery): Promise<T[]>;
  /** Run a parameterized query and return the first row, or null. */
  one<T = Record<string, unknown>>(q: SqlQuery): Promise<T | null>;
  /**
   * Execute trusted raw DDL (migration files authored in this repo). Not for
   * caller data: it bypasses parameterization by design, so it is only ever
   * handed statements we wrote, never anything derived from input.
   */
  exec(rawSql: string): Promise<void>;
  /** Run a function inside a transaction; commit on success, roll back on throw. */
  tx<R>(fn: (db: Db) => Promise<R>): Promise<R>;
  /** Close the underlying pool. */
  close(): Promise<void>;
  readonly pool: pg.Pool;
}

/** Create a database handle from resolved config (opens a single shared pool). */
export function createDb(config: DbConfig): Db {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  return makeDb(pool, pool);
}

/** Wrap an existing pool (for tests that manage their own lifecycle). */
export function createDbFromPool(pool: pg.Pool): Db {
  return makeDb(pool, pool);
}

function makeDb(pool: pg.Pool, executor: Queryable): Db {
  const run = async (text: string, values?: readonly unknown[]): Promise<pg.QueryResult> => {
    try {
      return await executor.query(text, values);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      throw new DbError(`Query failed${code ? ` (${code})` : ""}: ${text}`, { code, cause });
    }
  };

  const db: Db = {
    async query<T>(q: SqlQuery): Promise<T[]> {
      return (await run(q.text, q.values)).rows as T[];
    },
    async one<T>(q: SqlQuery): Promise<T | null> {
      const rows = (await run(q.text, q.values)).rows as T[];
      return rows[0] ?? null;
    },
    async exec(rawSql: string): Promise<void> {
      await run(rawSql);
    },
    async tx<R>(fn: (tx: Db) => Promise<R>): Promise<R> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(makeDb(pool, client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close(): Promise<void> {
      return pool.end();
    },
    pool,
  };
  return db;
}
