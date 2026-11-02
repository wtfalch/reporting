import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { withDrizzle } from '@wtfalch/db/drizzle';
import { runMigrationSources } from '@wtfalch/db/migrate';
import { createPgliteDatabase } from '@wtfalch/db/pglite';
import { createDatabase } from '@wtfalch/db/postgres';
import { type Db, tables } from '@wtfalch/reporting-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrationSources } from '../migrations-dir.js';
import { serviceTables } from '../tables.js';

const schemaTables = { ...tables, ...serviceTables };

export interface TestDb {
  db: Db;
  exec(text: string): Promise<void>;
  /** Raw rows for a query, whatever the driver. */
  query(text: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
  real: boolean;
}

async function dropSchema(url: string, schema: string): Promise<void> {
  const owner = createDatabase({ url: () => url, max: 1, applicationName: 'reporting-test' });
  try {
    await owner.database.query(`drop schema if exists "${schema}" cascade`);
  } finally {
    await owner.close({ timeoutMs: 5000 });
  }
}

/**
 * A fresh database with core's migrations and then this package's applied
 * through `@wtfalch/db`'s `runMigrationSources`, in `migrationSources` order,
 * as a host's migrate step does. PGlite in memory by default; with
 * TEST_DATABASE_URL a real Postgres, in a uniquely named schema that is
 * dropped on close, or at once if setup fails. `public` is never touched.
 */
export async function testDb(): Promise<TestDb> {
  const sources = [...migrationSources];
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const schema = `reporting_service_test_${randomUUID().replaceAll('-', '')}`;
    try {
      await runMigrationSources({ url, schema, sources, log: () => undefined });
    } catch (error) {
      await dropSchema(url, schema).catch(() => undefined);
      throw error;
    }
    const owner = createDatabase({
      url: () => url,
      searchPath: [schema],
      max: 4,
      applicationName: 'reporting-test',
    });
    return {
      db: withDrizzle(owner, { schema: schemaTables }).orm,
      exec: (text) => owner.database.query(text).then(() => undefined),
      query: (text) => owner.database.query(text),
      async close() {
        await owner.database.query(`drop schema "${schema}" cascade`);
        await owner.close({ timeoutMs: 5000 });
      },
      real: true,
    };
  }
  const client = new PGlite();
  const owner = createPgliteDatabase(client);
  await runMigrationSources({ owner, sources, log: () => undefined });
  return {
    db: drizzlePglite(client, { schema: schemaTables }),
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
