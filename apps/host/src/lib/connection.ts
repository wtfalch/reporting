import type { DatabaseOwner } from '@wtfalch/db';
import { createDatabase } from '@wtfalch/db/postgres';
import { requiredEnv } from '@wtfalch/utils/env';

/** The schema every reporting table, the ledger and the runtime role's grants
 * live in. `scripts/migrate.mjs` keeps its own copy of this literal, because it
 * is plain JavaScript; `scripts/migrate.test.ts` proves both name the same one. */
export const SCHEMA = 'reporting';

/** Every statement is cut off at this many ms, so one runaway query cannot
 * hold a connection other services on the same Postgres are waiting for. */
const STATEMENT_TIMEOUT_MS = 15_000;

/** A pool of at most `max` connections as the runtime role, with the schema
 * first on the `search_path` so an unqualified table name resolves in it. One
 * shared Postgres holds about 20 services, so a pool's size is a budget the
 * caller states. Throws if `DATABASE_URL` is unset, but opens no connection
 * until the first query.
 *
 * Returns the owner handle, not just its `database`: the service runs on
 * Drizzle (`withDrizzle(owner, ...)`), and the health check and the runtime
 * role guard run plain SQL over `owner.database`. */
export function openDatabase(applicationName: string, max: number): DatabaseOwner {
  return createDatabase({
    url: requiredEnv('DATABASE_URL'),
    applicationName,
    max,
    statementTimeoutMs: STATEMENT_TIMEOUT_MS,
    searchPath: [SCHEMA, 'public'],
  });
}
