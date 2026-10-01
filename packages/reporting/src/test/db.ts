import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { withDrizzle } from '@wtfalch/db/drizzle';
import { runMigrationSources } from '@wtfalch/db/migrate';
import { createPgliteDatabase } from '@wtfalch/db/pglite';
import { createDatabase } from '@wtfalch/db/postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrationsDir } from '../migrations-dir.js';
import { tables } from '../tables.js';
import type { Db } from '../types.js';

// Every migration on disk, in name order, so a new one is picked up without
// an edit here (a hand-kept list conflicts between branches that each add one).
export const MIGRATION_SQL = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), 'utf8'))
  .join('\n');

const sources = [{ name: 'reporting', dir: migrationsDir }];

export interface TestDb {
  db: Db;
  exec(text: string): Promise<void>;
  /** Raw rows for a query, whatever the driver. */
  query(text: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
  /** True on a real Postgres, where roles and a second connection exist. */
  real: boolean;
  /** Real Postgres only: the owner URL and the uniquely named schema the tables live in. */
  url?: string;
  schema?: string;
  /** Real Postgres only: a second pool on the same schema, the way a second container connects. */
  another?(): TestDb;
}

async function dropSchema(url: string, schema: string): Promise<void> {
  const owner = createDatabase({ url: () => url, max: 1, applicationName: 'reporting-test' });
  try {
    await owner.database.query(`drop schema if exists "${schema}" cascade`);
  } finally {
    await owner.close({ timeoutMs: 5000 });
  }
}

function realPool(url: string, schema: string, dropOnClose: boolean): TestDb {
  const owner = createDatabase({
    url: () => url,
    searchPath: [schema],
    max: 4,
    applicationName: 'reporting-test',
  });
  return {
    db: withDrizzle(owner, { schema: tables }).orm,
    exec: (text) => owner.database.query(text).then(() => undefined),
    query: (text) => owner.database.query(text),
    async close() {
      if (dropOnClose) await owner.database.query(`drop schema "${schema}" cascade`);
      await owner.close({ timeoutMs: 5000 });
    },
    real: true,
    url,
    schema,
    another: () => realPool(url, schema, false),
  };
}

/**
 * A fresh Postgres with the package's migrations applied through
 * `@wtfalch/db`'s `runMigrationSources`, as a host's migrate step does.
 * PGlite in memory by default, so the tests need no Docker. With
 * TEST_DATABASE_URL set, a real Postgres: a uniquely named schema is
 * created, migrated, handed back as the only schema on the `search_path`,
 * and dropped on close, or at once if setup fails. `public` is never
 * touched.
 */
export async function testDb(): Promise<TestDb> {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const schema = `reporting_test_${randomUUID().replaceAll('-', '')}`;
    try {
      await runMigrationSources({ url, schema, sources, log: () => undefined });
    } catch (error) {
      await dropSchema(url, schema).catch(() => undefined);
      throw error;
    }
    return realPool(url, schema, true);
  }
  const client = new PGlite();
  const owner = createPgliteDatabase(client);
  await runMigrationSources({ owner, sources, log: () => undefined });
  return {
    db: drizzlePglite(client, { schema: tables }),
    exec: (text) => client.exec(text).then(() => undefined),
    query: async (text) => (await client.query(text)).rows as Record<string, unknown>[],
    close: () => owner.close(),
    real: false,
  };
}

/** A logger that remembers, for asserting what reached the container log. */
export function memoryLog() {
  const lines: { level: 'info' | 'warn' | 'error'; obj: object; msg?: string }[] = [];
  return {
    lines,
    info: (obj: object, msg?: string) => void lines.push({ level: 'info', obj, msg }),
    warn: (obj: object, msg?: string) => void lines.push({ level: 'warn', obj, msg }),
    error: (obj: object, msg?: string) => void lines.push({ level: 'error', obj, msg }),
  };
}
