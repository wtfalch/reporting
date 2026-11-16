#!/usr/bin/env node
// Applies core's migrations, then the service package's, then this host's own
// (apps/host/drizzle/*.sql), to DATABASE_URL_OWNER, then creates or syncs the
// runtime role DATABASE_URL names. `@wtfalch/db` does the work: one
// transaction per file, one ledger (`reporting._migrations_sources`), one
// session advisory lock for the whole run so two containers starting at once
// take turns instead of racing. Copied from wtfalch/analytics' host.
//
// Everything lives in schema `reporting`, not `public`: the runner creates it,
// puts the ledger and every unqualified table in it, and the runtime role is
// granted that schema only (analytics ADR 0006 and ADR 0014).
//
// THIS WANTS ADDITIVE MIGRATIONS
// -------------------------------
// Old and new containers overlap during a rolling deploy, so a migration
// that drops or renames something breaks the still-running old one. Add a
// column, backfill it, drop the old one in a later release (analytics
// ADR 0015).
//
// The password in DATABASE_URL is never logged, here or by `@wtfalch/db`, and
// a failure prints the error's name only: a driver's message can quote a
// connection detail.
import { fileURLToPath } from 'node:url';
import { runMigrationSources } from '@wtfalch/db/migrate';
import { ensureRuntimeRole } from '@wtfalch/db/runtime-role';
import { migrationSources } from '@wtfalch/reporting-service/migrations-dir';
import { APPEND_ONLY, NO_DELETE, RUNTIME_FUNCTIONS } from './runtime-grants.mjs';

// One schema per service, a constant (apps/host/src/lib/connection.ts has the
// same literal for the server's search_path; migrate.test.ts checks they agree).
const SCHEMA = 'reporting';
const HOST_DIR = fileURLToPath(new URL('../drizzle/', import.meta.url));

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`migrate: ${name} is required`);
  return value;
}

async function main() {
  const ownerUrl = requiredEnv('DATABASE_URL_OWNER');
  const runtimeUrl = requiredEnv('DATABASE_URL');
  await runMigrationSources({
    url: ownerUrl,
    schema: SCHEMA,
    // The database is a separate container and may still be starting: the
    // runner probes it for up to a minute instead of crash-looping.
    waitMs: 60_000,
    // Core first, then the service (`migrationSources`, in that order: the
    // service's README calls the order the contract), host last: no host file
    // runs before a package file it would need. The lock id is left unset:
    // one lock per database, so services sharing it take turns.
    sources: [...migrationSources, { name: 'host', dir: HOST_DIR }],
  });
  await ensureRuntimeRole({
    ownerUrl,
    runtimeUrl,
    schemas: [SCHEMA],
    // The service README's and core's README's lists (runtime-grants.mjs):
    // revoked after the blanket grant, every boot, so a re-grant never undoes
    // a migration's revoke. runtime-role-guard.ts checks the same lists.
    appendOnly: APPEND_ONLY,
    noDelete: NO_DELETE,
    grants: RUNTIME_FUNCTIONS.map((signature) => `${SCHEMA}.${signature}`),
    settings: { search_path: `${SCHEMA}, public` },
  });
}

/** The error's name and, for a Postgres error, its five-character SQLSTATE:
 * enough to tell a refused login from a failed statement, and nothing a
 * message could quote. */
function describe(error) {
  const name = error instanceof Error ? error.name : 'unknown';
  const code = /** @type {{ code?: unknown } | undefined} */ (error)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `${name} ${code}` : name;
}

main().catch((error) => {
  console.error(`migrate: failed (${describe(error)})`);
  process.exitCode = 1;
});
