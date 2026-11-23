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
export interface LoggedStatement {
  /** The top-level transaction the statement ran in, `null` outside any. */
  readonly tx: number | null;
  readonly sql: string;
  readonly params: unknown[];
}

/** The client, with each query recorded and each top-level transaction numbered. */
function logged(client: PGlite, statements: LoggedStatement[]): PGlite {
  let counter = 0;
  const wrap = <T extends object>(target: T, tx: number | null): T =>
    new Proxy(target, {
      get(inner, prop) {
        const value = Reflect.get(inner, prop, inner);
        if (typeof value !== 'function') return value;
        if (prop === 'query') {
          return (text: string, params: unknown[] = [], ...rest: unknown[]) => {
            statements.push({ tx, sql: text, params });
            return value.call(inner, text, params, ...rest);
          };
        }
        if (prop === 'transaction' && tx === null) {
          return (work: (handle: PGlite) => Promise<unknown>) => {
            const id = ++counter;
            return value.call(inner, (handle: PGlite) => work(wrap(handle, id)));
          };
        }
        return value.bind(inner);
      },
    });
  return wrap(client, null);
}

export async function pgliteStore(): Promise<{
  readonly owner: DatabaseOwner;
  readonly orm: ReturnType<typeof drizzle>;
  /** Every statement `orm` ran, in order. */
  readonly statements: LoggedStatement[];
  rows(text: string): Promise<Record<string, unknown>[]>;
}> {
  const client = new PGlite();
  const owner = createPgliteDatabase(client);
  await runMigrationSources({ owner, sources: [...migrationSources], log: () => undefined });
  const statements: LoggedStatement[] = [];
  return {
    owner,
    orm: drizzle(logged(client, statements), { schema: { ...tables, ...serviceTables } }),
    statements,
    rows: async (text) => (await client.query(text)).rows as Record<string, unknown>[],
  };
}
