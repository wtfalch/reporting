import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Database } from '@wtfalch/db';
import { runMigrationSources } from '@wtfalch/db/migrate';
import { createDatabase } from '@wtfalch/db/postgres';
import { migrationSources } from '@wtfalch/reporting-service/migrations-dir';

const HOST_DIR = fileURLToPath(new URL('../drizzle/', import.meta.url));

/**
 * The host's real, complete schema -- core's tables, the service's and the
 * host's own -- applied through the same `runMigrationSources` sources
 * `scripts/migrate.mjs` passes, into a fresh uniquely-named schema on
 * `TEST_DATABASE_URL`. `owner` is a connection whose `search_path` is that
 * schema; `admin` has none, for role and database DDL. Real Postgres only:
 * callers `skipIf` it is unset.
 */
export async function migratedSchema(prefix: string): Promise<{
  readonly url: string;
  readonly schema: string;
  readonly owner: Database;
  readonly admin: Database;
  close(): Promise<void>;
}> {
  const url = process.env.TEST_DATABASE_URL as string;
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  await runMigrationSources({
    url,
    schema,
    sources: [...migrationSources, { name: 'host', dir: HOST_DIR }],
    log: () => undefined,
  });
  const ownerConnection = createDatabase({ url, max: 2, searchPath: [schema, 'public'] });
  const adminConnection = createDatabase({ url, max: 1 });
  return {
    url,
    schema,
    owner: ownerConnection.database,
    admin: adminConnection.database,
    async close() {
      await ownerConnection.close();
      await adminConnection.database.query(`DROP SCHEMA ${schema} CASCADE`);
      await adminConnection.close();
    },
  };
}
