import { type Db, createDb, hasDatabase, loadDbConfig } from "@readsmith/db";

/**
 * Server-only, lazily-created database handle. The persistence backbone is
 * OPTIONAL: without DATABASE_URL the app runs docs-only exactly as before (zero
 * external services), and this returns null. With it set, one shared pool is
 * reused across route handlers and the boot instrumentation.
 */
let handle: Db | null | undefined;

export function getDb(): Db | null {
  if (handle === undefined) {
    handle = hasDatabase() ? createDb(loadDbConfig()) : null;
  }
  return handle;
}
