# @wtfalch/reporting

The estate's operational event log and the housekeeping tick behind it: a
writer that never fails a request, a claim protocol that needs no scheduler,
and the readers an operator opens. Per-app Postgres, a host-supplied logger,
a framework-neutral core and a Next entry. The design and its decisions were
originally `docs/plans/reporting.md` and `docs/plans/reporting/core.md` in
`wtfalch/app-template`, which was archived 2026-09-24 and replaced by
`foundry`; those docs are a historical record only. The design history for
everything past 0.2.0 lives in this repo's own `docs/plans/errors.md` and
`CHANGELOG.md`.

This package holds the **events** (what the system did: jobs, drains,
alerts, an integration saying no) and the **errors** record. The **audit**
trail (who did what to what) is `@wtfalch/audit` and is not here: an audit
row is transactional and its actor is unforgeable; an event row is best
effort. The two share column names so a reader can walk between them, and
nothing else.

Analytics (how people use the product) lived here from 0.2.0 to 0.9.0; it
moved to its own repo, [`wtfalch/analytics`](https://github.com/wtfalch/analytics),
and this package no longer reads, writes or ships any analytics code
(issue #71). Migrations `0002_analytics.sql` and `0005_analytics_session_index.sql`
stay, because a migration only adds: the `reporting_analytics*` tables and
their functions still exist in a database that applied them, holding
whatever rows this package wrote before the move, until a later migration
drops them once that data has moved to the new package's own store.

## Status

Published: yes, v0.5.1, 2026-09-28

## Install

```sh
pnpm add @wtfalch/reporting @wtfalch/db
```

The package ships SQL and never connects or migrates. The host installs
`@wtfalch/db`, applies the SQL with the owner credential into a schema of
its own, then makes the runtime role. The runtime `searchPath` and
`ensureRuntimeRole({ schemas })` must both cover that schema. The SQL names
no schema and no role: its `SECURITY DEFINER` functions use `set search_path
from current`, so they find their tables in whatever schema the host
migrated into. Migrate with `@wtfalch/db` 0.5.2 or later: 0.5.0 and 0.5.1
let a temp table shadow a table inside a `SECURITY DEFINER` function, and
0.5.2 puts `pg_temp` last on the runner's `search_path`.

```ts
import { migrationsDir as reportingMigrations } from '@wtfalch/reporting/migrations-dir';
import { runMigrationSources } from '@wtfalch/db/migrate';
import { ensureRuntimeRole } from '@wtfalch/db/runtime-role';

await runMigrationSources({
  url: ownerUrl,
  schema: 'myservice', // created if missing; the tables land here, never in public
  sources: [
    { name: 'reporting', dir: reportingMigrations }, // before the host's own
    { name: 'app', dir: 'drizzle' },
  ],
});

await ensureRuntimeRole({
  ownerUrl,
  runtimeUrl,
  schemas: ['myservice'],
  appendOnly: ['reporting_events'], // insert and read only
  noDelete: [ // insert and update, never delete (needs @wtfalch/db 0.5.2 or later)
    'reporting_tasks',
    'reporting_settings',
    'reporting_errors',
    'reporting_tenant_settings',
    'reporting_error_tenants',
    'reporting_requests',
  ],
  grants: [ // the three security definer functions this package's own code still calls, schema-qualified
    'myservice.reporting_prune_events(interval, integer)',
    'myservice.reporting_prune_errors(interval, integer)',
    'myservice.reporting_prune_open_errors(integer, integer)',
  ],
});
```

A database migrated before 1.0.0 also carries the analytics tables and
their four functions (`reporting_rollup_day`, `reporting_rollup_week`,
`reporting_prune_analytics`, `reporting_erase_person`); this package's code
no longer calls them, so a host moving to 1.0.0 may drop their grants from
its own `ensureRuntimeRole`/`assertRuntimeRole` calls along with this one's.

Run `ensureRuntimeRole` after every migration run: the lists apply to the
tables that exist at that moment. `grants` entries are spliced into SQL, so
they are trusted text. Without `noDelete` the role can delete from those six
tables. These are the privileges the
package's own tests check, on a real Postgres, in a named schema.

At boot, check the role over the runtime connection, whose `searchPath`
includes the schema:

```ts
import { assertRuntimeRole } from '@wtfalch/db/runtime-role';

await assertRuntimeRole(connection.database, {
  appendOnly: ['myservice.reporting_events'],
  noDelete: [
    'myservice.reporting_tasks',
    'myservice.reporting_settings',
    'myservice.reporting_errors',
    'myservice.reporting_tenant_settings',
    'myservice.reporting_error_tenants',
    'myservice.reporting_requests',
  ],
});
```

The runtime handle is the native Drizzle one: pass `withDrizzle(runtime, {
schema: tables }).orm` (or `tx.orm`) from `@wtfalch/db/drizzle`.

Without `@wtfalch/db`, `reporting-migrations` still copies
`migrations/*.sql` into `drizzle/` as the next numbers and the host applies
them itself. Prefer `runMigrationSources`: the copy path has no schema and no
runtime-role step, so the host must grant and revoke by hand.

## Bind it once

```ts
// src/lib/reporting/core.ts, the one file that imports your raw handle
import { createReporting } from '@wtfalch/reporting';
import { createHousekeeping, pruneErrors, pruneEvents, retentionLag } from '@wtfalch/reporting/housekeeping';
import { deferWithAfter } from '@wtfalch/reporting/next';

export const reporting = createReporting({
  db,                       // your drizzle handle
  log,                      // pino-shaped: info / warn / error
  site: 'my-app',           // stamped on every row
  defer: deferWithAfter,    // after() under Next; a timer elsewhere
  onAlert: (f) => Sentry.captureMessage(f.message, { tags: { alert: f.check } }),  // optional
});

export const housekeeping = createHousekeeping({ reporting });
housekeeping.register(pruneEvents);
housekeeping.register(pruneErrors);
housekeeping.register(retentionLag);
```

Re-export the tables from your schema module so your drizzle instance knows
them:

```ts
export { reportingEvents, reportingTasks, reportingSettings } from '@wtfalch/reporting';
```

## Write

```ts
reporting.event({
  kind: 'mail.write_refused',          // namespace.name
  level: 'warn',                       // info | warn | error | alert
  message: 'the instance said no',     // ≤ 512
  tenantId, requestId,                 // optional
  actor: { class: 'human', id },       // optional; never a bare id
  target: { type: 'mailbox', id },     // optional
  data: { type: 'forbidden', attempt: 2 },  // flat scalars only, ≤ 16 KB, no banned keys
});

reporting.alert({ check: 'orphan_memberships', message: '2 rows', detail: rows });
```

`event()` writes a logger line first, queues the row, and flushes after the
current unit of work and on a timer. It never throws in production: a row it
refuses (a nested `data`, a key named `email`, `password`, `token`, ...)
becomes one `reporting.invalid` row and a logger error. In development and
test it throws, so the mistake is found. `alert()` projects a finding's
`detail` into flat fields (an array becomes its count) and then calls your
`onAlert`.

## Read

```ts
const page = await reporting.events.page({ level: 'error', kindNs: 'mail', limit: 50 });
// { items, next }  newest first; pass `after: page.next` for the next page
```

No permission is applied here. Gate in your page.

## Housekeeping

Hang the tick off something that already happens often. Under Next, the
health route:

```ts
// src/app/api/health/route.ts
import { healthHandler } from '@wtfalch/reporting/next';
export const GET = healthHandler(housekeeping);
```

Each registered task has a cadence, a lease and a retry. The tick claims a
due task with `SELECT ... FOR UPDATE SKIP LOCKED` and a token in one short
transaction, runs it outside, and completes it fenced on the token, so any
number of containers share the work without an advisory lock. Execution is
at least once; write idempotent tasks. Register your own:

```ts
housekeeping.register({
  name: 'authz.alerts', every: 24 * 3600_000, lease: 60_000, retry: 3600_000,
  run: async (ctx) => { for (const f of await runAlerts(ctx.db)) ctx.reporting.alert(f); },
});
```

## Settings

`reporting.settings.get()` / `set(patch, by)`. `events.retention_days`
(default 30, bounds 7 to 400) is what `pruneEvents` reads. The prune
function clamps whatever it is handed to the same bounds, so an operator's
edit can shorten history to a week and no further. Pass `audit` to
`createReporting` to have every change handed to your audit ledger after it
commits.

## Release health (0.8.0)

With `REPORTING_RELEASE` (an image digest) and `REPORTING_COLOR` (`blue` or
`green`) set, every event and error row carries both. Count each
response and mount the read foundry judges a new color by:

```ts
// app/api/reporting/release-health/route.ts
import { releaseHealthHandler } from '@wtfalch/reporting/next';
export const GET = releaseHealthHandler({ db, reporting });

// any route handler: counted per minute, color and release (status >= 500 is an error)
import { withRequestCount } from '@wtfalch/reporting/next';
export const POST = withRequestCount(reporting, async (req) => Response.json({ ok: true }));
```

`reporting.requests.record(status)` is the same count for a host that has no
route handler to wrap. Counts sit in memory and are written once per minute
bucket (every 10 seconds by default; `reporting.flush()` writes them now). The
read needs `Authorization: Bearer $REPORTING_HEALTH_TOKEN`: 401 for a missing or
wrong token, 503 when the variable is unset. It answers `from` and `to` (ISO,
`from` before `to`, at most 8 days; otherwise 400) with request and 5xx counts
per color and the per-day average of the 7 days before `from`. Counts only; no
event content. Rows of `reporting_requests` are not pruned.

### Count every request (0.9.0)

`withRequestCount` counts one route handler. To count every request with no
change per route, add one line to `proxy.ts` and one to `instrumentation.ts`:

```ts
// src/proxy.ts: wrap the proxy function you already export
import { countRequests } from '@wtfalch/reporting/next';
export const proxy = countRequests(reporting, async (request) => { /* as before */ });

// src/instrumentation.ts: pass the handler you already export (Sentry's, say) as the second argument
import { countRequestErrors } from '@wtfalch/reporting/next';
export const onRequestError = countRequestErrors(reporting, Sentry.captureRequestError);
```

The proxy counts each request it sees with the status it answers with (a
redirect or a 403 is a request; its own throw is a 500). A request it passes
through is counted as a request there, and a page, route handler or Server
Action that then throws reaches `onRequestError`, which adds the 5xx. A route
handler that returns a 500 without throwing is not seen; use `withRequestCount`
there. `/api/health` and `/api/reporting/release-health` are not counted
(`skipPaths` replaces that list). Do not wrap a route in `withRequestCount`
when the proxy matcher covers it: it would be counted twice. In Next 16
`proxy.ts` runs on the Node runtime only, which is where the in-memory counter
and its Postgres flush work; on the Edge runtime both functions count nothing.
A counting failure is logged and never fails the request.

## Shutdown

```ts
import { registerShutdownFlush } from '@wtfalch/reporting/next';
registerShutdownFlush(reporting);   // one bounded flush on SIGTERM
```

Best effort. The queue is per process and bounded at 1,000; the logger has
every row regardless.

## Analytics moved (0.2.0 to 0.9.0, moved in 1.0.0)

This package carried analytics -- the beacon, the collector, the rollups and
`reporting.analytics.track` -- from 0.2.0 through 0.9.0. William, 2026-10-11:
"reporting will be for systems reporting". It now lives in its own repo,
[`wtfalch/analytics`](https://github.com/wtfalch/analytics), published as
`@wtfalch/analytics`; see that package for the beacon, the collector and the
read API. Nothing in `@wtfalch/reporting` reads, writes or serves analytics
any more.

Migrations `0002_analytics.sql` and `0005_analytics_session_index.sql` stay
in this package (a migration only adds), so a host that already applied them
keeps the `reporting_analytics`, `reporting_analytics_daily` and
`reporting_analytics_weekly` tables and the four functions that wrote them,
holding whatever rows this package wrote before 1.0.0. A later migration
drops them once that data has moved to `@wtfalch/analytics`'s own store.

## Tests

No package ships a stand-in for a service. `createFakeReporting` (same
validation, no database, `fake.rows` is the table) is this package's own
unexported test double, under `src/test/`, for its own test files only -- a
host writes its own double, or runs this package against a real database.

## What this package never does

Read a request or a session, decide a permission, connect to a database of
its own, import `next` from the core, or store an ip, a user agent, an
email address or a display name. See `PRIVACY.md`.
