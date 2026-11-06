// What the runtime role may do, beyond `ensureRuntimeRole`'s blanket
// SELECT/INSERT/UPDATE/DELETE on every table in the schema. One list for both
// halves of analytics ADR 0014: `migrate.mjs` passes these to
// `ensureRuntimeRole`, and `src/lib/runtime-role-guard.ts` passes the same
// tables, schema-qualified, to `assertRuntimeRole`, so the role the migration
// made and the role the server checks cannot drift apart.
//
// The tables are the service README's list ("Migrations", packages/service)
// and core's README list ("Install", packages/reporting), unqualified: the
// caller adds the schema where it needs one.

/** Insert and read only: UPDATE, DELETE and TRUNCATE are revoked every run.
 * `audit_events` (the service's; its triggers refuse a change for every role
 * anyway) and `reporting_events` (core's timeline). */
export const APPEND_ONLY = ['audit_events', 'reporting_events'];

/** Insert and update, never delete: DELETE and TRUNCATE are revoked every
 * run. The service's site keys (a revoke stamps `revoked_at`; nothing deletes
 * a key), its alert rules, releases and sent alerts (a rule turned off is a
 * row with `enabled` false; a mail's row is what keeps it from going twice),
 * and core's six tables. */
export const NO_DELETE = [
  'reporting_site_keys',
  'reporting_alert_rules',
  'reporting_releases',
  'reporting_alerts',
  'reporting_tasks',
  'reporting_settings',
  'reporting_errors',
  'reporting_tenant_settings',
  'reporting_error_tenants',
  'reporting_requests',
];

// The runtime role's own SECURITY DEFINER functions: a fixed list, not "every
// function in the schema". `migrate.mjs` passes it to `ensureRuntimeRole` as
// `grants`, which runs `GRANT EXECUTE ON FUNCTION` for each name. That is all
// it does: it does NOT restrict who else can call a function. Core's
// migrations `REVOKE ALL ... FROM PUBLIC` on every one of theirs, so a
// function missing here is not callable by the runtime role.
//
// These three are the ones core's README says its own code calls (its
// housekeeping prunes). Unqualified: `migrate.mjs` adds the schema. A test
// (tests/runtime-functions.test.ts) fails if a SECURITY DEFINER function in the
// schema is in neither this list nor `NOT_GRANTED`.
/** @type {string[]} */
export const RUNTIME_FUNCTIONS = [
  'reporting_prune_events(interval, integer)',
  'reporting_prune_errors(interval, integer)',
  'reporting_prune_open_errors(integer, integer)',
];

/** SECURITY DEFINER functions core's migrations still create and nothing here
 * calls: the analytics rollups and erase, which moved to wtfalch/analytics
 * (core README). A migration only adds, so they stay in the schema; the
 * runtime role is never granted them. */
/** @type {string[]} */
export const NOT_GRANTED = [
  'reporting_rollup_day(date)',
  'reporting_rollup_week(date)',
  'reporting_prune_analytics(interval, integer, date)',
  'reporting_erase_person(text)',
];
