import { PGlite } from '@electric-sql/pglite';
import { runMigrationSources } from '@wtfalch/db/migrate';
import { createPgliteDatabase } from '@wtfalch/db/pglite';
import type { Db } from '@wtfalch/reporting-core';
import { tables } from '@wtfalch/reporting-core';
import { migrationsDir } from '@wtfalch/reporting-core/migrations-dir';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';

const sources = [{ name: 'reporting', dir: migrationsDir }];

export interface TestDb {
  readonly db: Db;
  close(): Promise<void>;
}

/** A fresh in-memory Postgres (PGlite) with `@wtfalch/reporting-core`'s own migrations applied, the same way a host's migrate step does (see migrate.ts). */
export async function testDb(): Promise<TestDb> {
  const client = new PGlite();
  const owner = createPgliteDatabase(client);
  await runMigrationSources({ owner, sources, log: () => undefined });
  return {
    db: drizzlePglite(client, { schema: tables }),
    close: () => owner.close(),
  };
}

/** A logger that remembers, for asserting what reached it. */
export function memoryLog() {
  const lines: { level: 'info' | 'warn' | 'error'; obj: object; msg?: string }[] = [];
  return {
    lines,
    info: (obj: object, msg?: string) => void lines.push({ level: 'info', obj, msg }),
    warn: (obj: object, msg?: string) => void lines.push({ level: 'warn', obj, msg }),
    error: (obj: object, msg?: string) => void lines.push({ level: 'error', obj, msg }),
  };
}
