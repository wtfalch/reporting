import { PGlite } from '@electric-sql/pglite';
import type { DatabaseOwner } from '@wtfalch/db';
import { runMigrationSources } from '@wtfalch/db/migrate';
import { createPgliteDatabase } from '@wtfalch/db/pglite';
import { tables } from '@wtfalch/reporting-core';
import { serviceTables } from '@wtfalch/reporting-service';
import { migrationSources } from '@wtfalch/reporting-service/migrations-dir';
import { drizzle } from 'drizzle-orm/pglite';

/**
 * An in-memory database with core's migrations and the service's applied in
 * `migrationSources` order, as `scripts/migrate.mjs` applies them, for the
 * tests that run the real routes without a Postgres. `owner` stands in for
 * what `openDatabase` returns; `orm` for what `withDrizzle(owner).orm` does,
 * since `withDrizzle` binds to the postgres driver and PGlite has its own.
 * PGlite has no roles, so a test that uses this mocks the role check.
 */
export async function pgliteStore(): Promise<{
  readonly owner: DatabaseOwner;
  readonly orm: ReturnType<typeof drizzle>;
  rows(text: string): Promise<Record<string, unknown>[]>;
}> {
  const client = new PGlite();
  const owner = createPgliteDatabase(client);
  await runMigrationSources({ owner, sources: [...migrationSources], log: () => undefined });
  return {
    owner,
    orm: drizzle(client, { schema: { ...tables, ...serviceTables } }),
    rows: async (text) => (await client.query(text)).rows as Record<string, unknown>[],
  };
}
