# Changelog

## 0.7.0 — unreleased

Moves migration and the runtime role onto `@wtfalch/db` 0.5.2. 0.6.0 was never
released: npm has 0.5.1, and a host moving from it takes every Breaking entry
below and the 0.6.0 ones under "Breaking since 0.5.1".

Breaking:

- **The SQL names no role and no schema.** `migrations/0001` to `0003` and
  `0006` to `0008` are edited in place (no database has applied them;
  package-template ADR 0015 allows that where no consumer has applied a file).
  The nine `SECURITY DEFINER` function definitions (seven distinct functions)
  use `set search_path from current` instead of the literal `pg_catalog,
  public`, so they find their tables in whatever schema the host migrated
  into. Every `DO` block that computed `<database>_rt` to revoke and grant is
  deleted. A host that applied the old files has a database these files would
  no longer match; recreate it empty, as the estate's databases are in this
  move.
- **The revokes and grants move to the host.** `ensureRuntimeRole` from
  `@wtfalch/db` replaces the `<database>_rt` blocks: `appendOnly`, `readOnly`,
  `noDelete` and `grants` with seven schema-qualified function signatures. A
  host that does not pass them has a runtime role that can UPDATE and DELETE
  the event log and delete from every table. See "Moving from 0.6".
- `drizzle-orm` peer is `>=0.39.3 <1.0.0` (was `>=0.39.0`); the devDependency
  is `0.39.3`, the low end. Checked at both ends: `0.39.3` is the pinned
  devDependency, and `0.45.3` was installed in turn, with a clean typecheck and
  the full suite passing on PGlite and on Postgres 17.
- `@wtfalch/db` 0.5.2 is a devDependency (tests); `postgres` left the
  devDependencies. Neither is a dependency or a peer.

Added:

- `migrationsDir`, the absolute path of the shipped `.sql` files, from the
  subpath `@wtfalch/reporting/migrations-dir`. The subpath imports only
  `node:url`, so a migration image or a bundler never loads the main entry for
  it. It is not exported from `@wtfalch/reporting`.
- Tests: the fixture applies the migrations with `runMigrationSources`. With
  `TEST_DATABASE_URL` each test file gets a uniquely named schema, dropped
  after and when setup fails; `public` is never dropped or touched. A default-
  tier test migrates into a named schema and proves the tables and functions
  are not in `public`. The privilege tests log in as a role made by
  `ensureRuntimeRole` and also run the `FOR UPDATE SKIP LOCKED` claim, the
  error-capture savepoint and the `set local statement_timeout` prune batches
  through it.

Unchanged: the `reporting-migrations` copy bin and the `./migrations/*.sql`
export; the bin is the second path, `runMigrationSources` the preferred one.
The handle stays the native Drizzle one (`Db`).

### Breaking since 0.5.1, the last release on npm

1. 0.7.0: the two entries above, the `drizzle-orm` peer range.
2. 0.6.0: `migrations/0007_errors_open_cap.sql` and
   `migrations/0008_error_tenants.sql` are new, and **0008 must be applied
   before upgrading**; without it capture logs a warning and writes no tenant
   row. `errorsPage` and `errorDetail` take `tenantId`; with it they return
   `TenantErrorRow`, and an empty, non-uuid or explicitly undefined `tenantId`
   throws instead of reading every tenant. Error fingerprints hash the
   redacted text, so a group that held PII starts a new row on upgrade.

### Moving from 0.6

Before, the host copied the SQL and relied on a role named after the database:

```sh
pnpm exec reporting-migrations   # into drizzle/, applied by the host's migrate script
```

The `DO` blocks revoked `UPDATE, DELETE, TRUNCATE` on the events and raw
analytics tables, everything but `SELECT` on the rollups, and `DELETE,
TRUNCATE` on five tables, then granted `EXECUTE` on the functions, all to
`<database>_rt`. In a named schema on a shared database they would have found
no such role and done nothing.

After, with the owner credential, once per deploy (full docs:
https://github.com/wtfalch/reporting/blob/main/packages/reporting/README.md):

```ts
import { migrationsDir as reportingMigrations } from '@wtfalch/reporting/migrations-dir';
import { runMigrationSources } from '@wtfalch/db/migrate';
import { ensureRuntimeRole } from '@wtfalch/db/runtime-role';

await runMigrationSources({
  url: ownerUrl,
  schema: 'myservice',
  sources: [
    { name: 'reporting', dir: reportingMigrations }, // before the host's own
    { name: 'app', dir: 'drizzle' },
  ],
});
await ensureRuntimeRole({
  ownerUrl,
  runtimeUrl,
  schemas: ['myservice'],
  appendOnly: ['reporting_events', 'reporting_analytics'],
  readOnly: ['reporting_analytics_daily', 'reporting_analytics_weekly'],
  noDelete: ['reporting_tasks', 'reporting_settings', 'reporting_errors',
             'reporting_tenant_settings', 'reporting_error_tenants'], // @wtfalch/db 0.5.2 or later
  grants: [
    'myservice.reporting_prune_events(interval, integer)',
    'myservice.reporting_rollup_day(date)',
    'myservice.reporting_rollup_week(date)',
    'myservice.reporting_prune_analytics(interval, integer, date)',
    'myservice.reporting_erase_person(text)',
    'myservice.reporting_prune_errors(interval, integer)',
    'myservice.reporting_prune_open_errors(integer, integer)',
  ],
});
```

Migrate with `@wtfalch/db` 0.5.2 or later. 0.5.0 and 0.5.1 let a temp table
shadow a table inside a `SECURITY DEFINER` function; 0.5.2 puts `pg_temp`
last on the runner's `search_path`. The runtime connection's `searchPath`
must include `myservice`; pass `withDrizzle(...).orm` to `createReporting`.

A host that copied the SQL with `reporting-migrations` must start over. Delete
the copied `.sql` files and the copy marker (`.reporting-migrations.json`), then run the bin again into an
empty database. The bin only adds files it has not copied, so an old copy of
`0001` to `0006` stays: it keeps the literal `pg_catalog, public` search path
and the `_rt` blocks, and only `0007` and `0008` would be copied.

Fixed: two concurrent captures of one error could commit out of time order.
The later commit then set `last_seen_at` before `first_seen_at`,
`reporting_errors_seen_check` failed, and the count stayed low. `last_seen_at`
now only moves forward.

## 0.6.0 — unreleased

- `pruneErrors` is now exported from `@wtfalch/reporting/housekeeping`. It
  existed and was tested but could not be imported, so no host could register
  it and `reporting_errors` was never pruned. It reads the same
  `events.retention_days` window as `pruneEvents` and never touches an
  'open' group. (#30)
- `errorsPage` and `errorDetail` take `tenantId` and return that tenant's own
  occurrences, from the new `reporting_error_tenants` table
  (`migrations/0008_error_tenants.sql`). **Apply 0008 before upgrading.**
  Without it, capture still writes the group row and logs a warning, but no
  tenant row, so a tenant-scoped page stays empty.
- In tenant scope the shared group's `message`, `stack`, `runtime`, `release`,
  `requestId`, `resolvedBy`, `state` and `resolvedAt` are null (type `TenantErrorRow`): they come from
  whichever tenant hit the group last, and showing them leaks one tenant's
  data to another. `search` matches `kind` only, and `runtime` and `state` are
  not filtered in tenant scope.
- Tenant scope is decided by whether `tenantId` is present. An empty or
  non-uuid string, or an explicit `tenantId: undefined`, throws instead of reading every tenant's data. `errorsPage`
  and `errorDetail` are overloaded: without `tenantId` they return
  `ReportingErrorRow` as before, with it `TenantErrorRow`.
- There is no backfill. The old table kept only the latest tenant per group, so
  copying its counts would credit that tenant with everyone's history. Counts
  per tenant start when 0.6.0 is deployed.
- Error fingerprints now hash the redacted text. A group whose message or
  stack contained PII (an email, a token, a URL password) gets a new
  fingerprint on upgrade, so it starts a new row. The old row keeps its
  unredacted text: operators should resolve the old rows.
- Redaction also covers `scheme://user:password@host` URLs, labelled secrets
  in JSON, colon and `%3D` forms, `x-api-key:` headers and a JSON `"cookie"`.

## 0.5.0 — 2026-09-23

- `errorDetail` and `setErrorState` are now exported from the package
  entry. They were unreachable from `@wtfalch/reporting` since 0.3.0, the
  same gap `errorsPage` had until 0.4.1 (#20). (#22)

## 0.4.1 — 2026-09-23

- `errorsPage` is now exported from the package entry. It was unreachable
  from `@wtfalch/reporting` since 0.3.0, so 0.4.0's `search` (#8) could not
  be called by a host. `ErrorsPageOptions` and `ErrorsPage` were already
  exported.

## 0.4.0 — 2026-09-23

The 2026-09-22 feature-gap audit. Three new migrations; apply them in order.

- `./next`: edge-safe error capture. Middleware and edge-runtime errors were
  silently dropped because capture needs the database; the edge handler now
  forwards them to a node route that records them (#4).
- `migrations/0004_environment.sql`: an `environment` column on
  `reporting_events` and `reporting_errors`, from `ReportingOptions.environment`,
  with an `environment` filter on both readers (#6).
- `reporting.analytics.recent({ sessionId })`, backed by
  `migrations/0005_analytics_session_index.sql`: everything one browser
  session did, for debugging a user's report (#9).
- `migrations/0006_tenant_settings.sql`: per-tenant retention overrides for
  `events.retention_days` and `analytics.retention_days`, read by the prune
  functions before the site-wide window, same 7-400 day clamp; the analytics
  prune still never passes the rollup watermark. `reporting.tenantSettings`
  reads and sets them (#11).
- `ReportingOptions.redactEnvVars`: extra environment variable names whose
  values redaction also removes from captured errors (#7).
- The errors reader (`errorsPage` in `src/errors/reader.ts`) takes `search`:
  a case-insensitive substring match against an error group's message or
  stack (#8).
- A new or reopened error group now fires an `alert.*` event through the same
  path as `reporting.alert()`, once per transition and never on a repeat
  occurrence of an open error (#5). Hosts that count events will see one more
  row when a new group appears.

## 0.3.1 — 2026-09-20

- `./browser`: `beacon.captureError(error, kind?)`. 0.3.0 captured only what
  the browser threw at `window`, and a React error boundary swallows the throw
  before `window.onerror` can see it -- which is the case `error.tsx` exists
  for, and the one thing `Sentry.captureException` was doing in a client
  component. Same de-duplication and the same per-page caps as a thrown error;
  a no-op when `errors` is off.

## 0.3.0 — 2026-09-20

The error record (docs/plans/errors.md). Sentry leaves the estate; this is the
one thing it did that 0.2.1 could not.

- `migrations/0003_errors.sql`: `reporting_errors`, one row per fingerprint,
  and `reporting_prune_errors`. An open error is never pruned whatever its age
  -- it leaves the table only after an operator resolves or ignores it, and
  then ages out. An unresolved error vanishing on a timer is what makes an
  error tracker untrustworthy.
- `reporting.captureError(error, context)`: one `reporting_events` row for the
  timeline, already indexed and already pruned, and one upsert into the group
  holding the count and the newest sample. Never throws to its caller and
  never fails a request; a reporter that throws while reporting is worse than
  one that stays quiet. A new occurrence reopens a resolved group.
- The fingerprint drops line and column numbers and masks a build hash in a
  bundled filename. Both drift for reasons unrelated to which bug this is, and
  either would open a new group on every deploy. Measured: the same bug groups
  across a laptop and a container, two server deploys, two chunk ids and two
  asset hashes.
- Redaction runs on the capture path, over message and stack, before the row
  is queued. It came from app-template's `src/lib/redact.ts`, where it guarded
  the key store's premise as Sentry's `beforeSend`, and is behaviourally
  identical to it.
- `errorHandler` and `clientErrorHandler` (`./next`), the latter a public
  ingest modelled on the analytics collector: always 204, the same origin
  allowance and body cap, a batch cap, and a per-address token bucket at 60
  captures a minute. Identity is the session's, never the body's.
- `./browser`: the beacon takes `errors`, capturing `window.onerror` and
  `unhandledrejection`, de-duplicated, capped at 5 distinct and 20 total per
  page load, cross-origin `"Script error."` dropped.
- `./react/errors`: `ErrorsTable`.
- `errorsPage`, `errorDetail`, `setErrorState`; the `pruneErrors` task, which
  reuses `events.retention_days` rather than adding a setting.
- The token bucket both public ingests share moves to `src/ingest-limit.ts`.
  The analytics route had one and the error route did not, which is not safe
  beside a table that never prunes an open row.
- `hookTimeout` is now explicit in the vitest config. `beforeAll` is a hook, so
  it was bound by the 10s default rather than the configured 30s, and a third
  migration pushed three database-heavy files past it.

## 0.2.1 — 2026-09-12

- `tenantFor(userId, pathname, route)`: the collector hands the host the
  pathname as sent (query string gone) beside the normalised route, since the
  route has already replaced the organisation id the host needs to check.

## 0.2.0 — 2026-09-12

The analytics record (docs/plans/reporting.md D13 to D15, D17; addendum A3,
A4, A5, A7).

- `migrations/0002_analytics.sql`: `reporting_analytics`, `_daily`, `_weekly`;
  `reporting_rollup_day`, `reporting_rollup_week`, `reporting_prune_analytics`
  (refuses a cutoff at or past the rollups' watermark), `reporting_erase_person`;
  `reporting_tasks.watermark`; the runtime role's grants.
- `createCollector` / `collectHandler` (`./next`): the public beacon collector.
  Same-origin identity from the host's session, foreign origins from an
  allowlist with no identity, every field validated, caps, clamped clocks,
  device and country derived and nothing else kept, per-visitor and per-ip
  token buckets, always 204.
- `reporting.analytics.track/series/weekly/recent`; `analyticsSeries`,
  `analyticsWeekly`, `analyticsRecent`, `hideSmallGroups`.
- `./browser`: `createBeacon`; `./react`: `ReportingProvider`, `useTrack`,
  `ConsentControl`; `./react/charts`: `Sparkline`, `BarList`.
- Housekeeping tasks `rollupAnalytics`, `rollupAnalyticsWeekly`,
  `pruneAnalytics`; `TaskContext.watermark` and `commitWatermark(value, tx)`.
- Settings `analytics.retention_days` (90), `analytics.consent` (`consented`),
  `analytics.identify_signed_in` (true).
