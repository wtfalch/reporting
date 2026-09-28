import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';
import type { Database, Queryable } from '../db.js';
import { migrate } from '../migrate.js';
import { postgresDatabase } from '../postgres.js';

/** Two-tier fixture: PGlite by default, a disposable real-Postgres schema
 * when `TEST_DATABASE_URL` is set. Both apply this package's own migrations
 * through `migrate()`, so the fixture and production start from the same
 * schema-creation path. */
export async function testDatabase() {
  if (process.env.TEST_DATABASE_URL) {
    const schema = `test_${randomUUID().replaceAll('-', '')}`;
    const admin = postgres(process.env.TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    const pg = postgres(process.env.TEST_DATABASE_URL, {
      max: 8,
      onnotice: () => {},
      connection: { search_path: schema },
    });
    const db = postgresDatabase(pg);
    await migrate(db);
    return {
      db,
      async close() {
        await pg.end();
        await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      },
    };
  }
  const pg = new PGlite();
  const wrap = (client: Pick<PGlite, 'query'>): Queryable => ({
    async query<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
      return (await client.query<T>(text, values)).rows;
    },
  });
  const db: Database = {
    ...wrap(pg),
    transaction: (work) => pg.transaction((tx) => work(wrap(tx))),
  };
  await migrate(db);
  return { db, close: () => pg.close() };
}
