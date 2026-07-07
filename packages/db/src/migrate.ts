import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./client.js";
import type { Logger } from "./log.js";

export interface Migration {
  order: number;
  name: string;
}

const NAME_PATTERN = /^(\d{4})_[a-z0-9-]+\.sql$/;

/**
 * Resolve migration filenames into an ordered plan. Enforces the `NNNN_name.sql`
 * convention and rejects duplicate order numbers (which would make apply order
 * ambiguous). Gaps are allowed. Pure and deterministic, so it is unit-testable
 * without a filesystem.
 */
export function resolveMigrations(files: readonly string[]): Migration[] {
  const migrations: Migration[] = [];
  const seen = new Set<number>();
  for (const file of files) {
    const match = NAME_PATTERN.exec(file);
    if (!match) {
      if (file.endsWith(".sql")) {
        throw new Error(`Migration filename does not match NNNN_name.sql: ${file}`);
      }
      continue;
    }
    const order = Number(match[1]);
    if (seen.has(order)) throw new Error(`Duplicate migration order ${order} (${file})`);
    seen.add(order);
    migrations.push({ order, name: file });
  }
  return migrations.sort((a, b) => a.order - b.order);
}

/** The directory holding this package's migration files. */
export function migrationsDir(): string {
  // The relative path is held in a variable so bundlers do not special-case the
  // `new URL(<literal>, import.meta.url)` form and try to resolve it at build
  // time; resolution happens at runtime against the real module location.
  const relative = "../migrations";
  return fileURLToPath(new URL(relative, import.meta.url));
}

/**
 * Apply all pending migrations in order, each in its own transaction, recording
 * applied files in `app.schema_migrations`. Idempotent: already-applied files are
 * skipped, so running twice is a no-op. Returns the names applied this run.
 */
export async function runMigrations(
  db: Db,
  options: { dir?: string; logger?: Logger } = {},
): Promise<string[]> {
  const dir = options.dir ?? migrationsDir();
  await bootstrap(db);

  const applied = new Set(
    (
      await db.query<{ name: string }>({
        text: "SELECT name FROM app.schema_migrations",
        values: [],
      })
    ).map((r) => r.name),
  );

  const files = await readdir(dir);
  const plan = resolveMigrations(files);
  const ran: string[] = [];

  for (const migration of plan) {
    if (applied.has(migration.name)) continue;
    const source = await readFile(join(dir, migration.name), "utf8");
    await db.tx(async (tx) => {
      await tx.exec(source);
      await tx.query({
        text: "INSERT INTO app.schema_migrations (name) VALUES ($1)",
        values: [migration.name],
      });
    });
    ran.push(migration.name);
    options.logger?.info("migration applied", { migration: migration.name });
  }
  return ran;
}

/** Create the `app` schema and the migration ledger if they do not yet exist. */
async function bootstrap(db: Db): Promise<void> {
  await db.exec(
    `CREATE SCHEMA IF NOT EXISTS app;
     CREATE TABLE IF NOT EXISTS app.schema_migrations (
       name       text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     );`,
  );
}
