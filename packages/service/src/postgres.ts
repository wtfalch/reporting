import type { Sql } from 'postgres';
import type { Database, Queryable } from './db.js';

function queryable(sql: Pick<Sql, 'unsafe'>): Queryable {
  return {
    async query<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
      return [...(await sql.unsafe<T[]>(text, values as never[]))];
    },
  };
}

/** Adapts a `postgres` connection to `Queryable`/`Database`. `postgres` is
 * imported type-only above, so this module loads even when the optional peer
 * is not installed; only calling `postgresDatabase` needs it at runtime. */
export function postgresDatabase(sql: Sql): Database {
  return {
    ...queryable(sql),
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      return (await sql.begin(async (tx) => work(queryable(tx)))) as T;
    },
  };
}
