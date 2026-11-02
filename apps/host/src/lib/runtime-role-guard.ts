import type { Queryable } from '@wtfalch/db';
import { UnsafeRuntimeRoleError, assertRuntimeRole } from '@wtfalch/db/runtime-role';
import { errorResponse } from '@wtfalch/reporting-service';
import { APPEND_ONLY, NO_DELETE } from '../../scripts/runtime-grants.mjs';
import { SCHEMA } from './connection';

export { UnsafeRuntimeRoleError };

/** The tables `assertRuntimeRole` holds the role to, schema-qualified.
 * `scripts/migrate.mjs` passes the same lists, unqualified, to
 * `ensureRuntimeRole` (`scripts/runtime-grants.mjs`). */
const TABLES = {
  appendOnly: APPEND_ONLY.map((table) => `${SCHEMA}.${table}`),
  noDelete: NO_DELETE.map((table) => `${SCHEMA}.${table}`),
};

/**
 * Postgres has two exemptions from every privilege a migration sets up -- a
 * superuser, and a table's own owner -- that no migration can close, because
 * a migration cannot see what role `DATABASE_URL` will actually resolve to in
 * a given deployment. This is the runtime half of closing it: before this
 * host's shared connection serves a request, it checks the role it is
 * actually connected as, and refuses to serve at all if that role could
 * bypass the grants, or write `audit_events` other than by appending.
 *
 * analytics ADR 0014 names the incident this closes. The check itself is
 * `assertRuntimeRole` from `@wtfalch/db/runtime-role`;
 * `apps/host/scripts/migrate.mjs`'s `ensureRuntimeRole` is the other half,
 * creating the role at migration time. This is the backstop for any database
 * this repo did not itself migrate -- a connection string pointed at the
 * owner by mistake, or at a role this repo never touched at all.
 */

/** Keyed on the connection object itself, not a global: each fresh
 * `Queryable` (a real connection, or a fake in a test) gets its own
 * first-check-wins result, so two tests using two different fakes never see
 * each other's cached outcome. */
const checked = new WeakMap<Queryable, Promise<void>>();

/**
 * Memoises only a verdict: a pass, or `UnsafeRuntimeRoleError`. Any other
 * failure (a dropped connection, a timeout) says nothing about the role, so it
 * clears the entry and the next call checks again.
 */
export function checkRuntimeRoleOnce(db: Queryable): Promise<void> {
  let promise = checked.get(db);
  if (!promise) {
    promise = assertRuntimeRole(db, TABLES);
    checked.set(db, promise);
    promise.catch((error) => {
      if (!(error instanceof UnsafeRuntimeRoleError)) checked.delete(db);
    });
  }
  return promise;
}

/**
 * Wraps the service's handler so every `/v1` request runs the check first (a
 * verdict is cached after the first -- see `checkRuntimeRoleOnce`).
 *
 * analytics wraps the database (`guardedDatabase`) instead. That cannot work
 * here: the reporting service runs on Drizzle, whose queries go through the
 * driver's own client and never through `database.query`, so a wrapped
 * `query` would guard nothing. Guarding the one handler every `/v1` route
 * calls is the same promise -- no route reaches the database before the
 * check -- kept at the one place every request passes.
 *
 * An unsafe role, or a check that could not run, answers `503 unavailable`
 * with the contract's fixed body, and logs the error's name only: never its
 * message, which can quote a role or a connection detail.
 */
export function guardedHandler(
  database: Queryable,
  handle: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      await checkRuntimeRoleOnce(database);
    } catch (error) {
      const name = error instanceof Error ? error.name : 'unknown';
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'reporting: refused to serve: the runtime role check did not pass',
          meta: { err: name },
        }),
      );
      return errorResponse('unavailable', 'Service unavailable');
    }
    return handle(request);
  };
}
