import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { tables } from '../tables.js';
import type { Db } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS = join(here, '..', 'migrations');
export const MIGRATION_SQL = [
  '0001_reporting.sql',
  '0002_analytics.sql',
  '0003_errors.sql',
  '0004_environment.sql',
  '0005_analytics_session_index.sql',
  '0006_tenant_settings.sql',
]
  .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
  .join('\n');

export interface TestDb {
  db: Db;
  exec(text: string): Promise<void>;
  /** Raw rows for a query, whatever the driver. */
  query(text: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
  /** True on a real Postgres, where roles and a second connection exist. */
  real: boolean;
}

/**
 * A fresh Postgres with the package's migration applied, as the host's
 * migrate script would. PGlite in memory by default, so the tests need no
 * Docker. With TEST_DATABASE_URL set, a real Postgres through postgres-js,
 * the driver the apps run on; its public schema is dropped first, so never
 * point it at anything that matters.
 */
export async function testDb(): Promise<TestDb> {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const client = postgres(url, { prepare: false, max: 4 });
    await client.unsafe('drop schema public cascade; create schema public;');
    await client.unsafe(MIGRATION_SQL);
    return {
      db: drizzlePostgres(client, { schema: tables }) as unknown as Db,
      exec: (text) => client.unsafe(text).then(() => undefined),
      query: async (text) => [...(await client.unsafe(text))] as Record<string, unknown>[],
      close: () => client.end(),
      real: true,
    };
  }
  const client = new PGlite();
  await client.exec(MIGRATION_SQL);
  return {
    db: drizzlePglite(client, { schema: tables }) as unknown as Db,
    exec: (text) => client.exec(text).then(() => undefined),
    query: async (text) => (await client.query(text)).rows as Record<string, unknown>[],
    close: () => client.close(),
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
