import { readFile, readdir } from 'node:fs/promises';
import type { Database } from './db.js';

const MIGRATIONS_TABLE = 'reporting_service_migrations';

/** Splits a migration file into its individual statements -- a `Queryable`
 * executes one statement per call (PGlite's `query` rejects multiple
 * commands in one call). Sufficient for this package's own migrations
 * (plain DDL, no dollar-quoted function bodies). */
function statementsOf(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Applies every migration under `migrationsDir` (default: the sibling
 * `migrations/` directory -- `src/migrations` in development, copied to
 * `dist/migrations` by `scripts/copy-migrations.mjs` for the published
 * layout) through `db`, in filename order, recording each by name in
 * `reporting_service_migrations`. One transaction per file. Idempotent: a file
 * already recorded is skipped, so calling this repeatedly is safe. Returns
 * the names newly applied. */
export async function migrate(
  db: Database,
  migrationsDir: URL = new URL('./migrations/', import.meta.url),
): Promise<string[]> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const appliedRows = await db.query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE}`);
  const applied = new Set(appliedRows.map((row) => row.name));
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(new URL(file, migrationsDir), 'utf8');
    await db.transaction(async (tx) => {
      for (const statement of statementsOf(sql)) await tx.query(statement);
      await tx.query(`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ($1)`, [file]);
    });
    newlyApplied.push(file);
  }
  return newlyApplied;
}
