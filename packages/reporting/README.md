# @wtfalch/reporting

The estate's operational event log and the housekeeping tick behind it: a
writer that never fails a request, a claim protocol that needs no scheduler,
and the readers an operator opens. Per-app Postgres, a host-supplied logger,
a framework-neutral core and a Next entry. The design and its decisions are
`docs/plans/reporting.md` and `docs/plans/reporting/core.md` in
`wtfalch/app-template`.

Three records make up reporting on the estate. This package holds the
**events** (what the system did: jobs, drains, alerts, an integration saying
no) and, from 0.2, **analytics** (how people use the product). The **audit**
trail (who did what to what) is `@wtfalch/audit` and is not here: an audit
row is transactional and its actor is unforgeable; an event row is best
effort. The two share column names so a reader can walk between them, and
nothing else.

## Install

```sh
pnpm add @wtfalch/reporting
pnpm exec reporting-migrations   # copies migrations/*.sql into drizzle/ as the next numbers
```

The copied migration creates `reporting_events`, `reporting_tasks` and
`reporting_settings`, a `SECURITY DEFINER` prune function, and, when a role
named `<database>_rt` exists, revokes UPDATE, DELETE and TRUNCATE on events
from it. That is the estate's runtime-role convention; a host without the
role gets the tables and the function and no revokes take effect. Your
migrate script applies the file; this package never connects to apply
anything.

## Bind it once

```ts
// src/lib/reporting/core.ts, the one file that imports your raw handle
import { createReporting } from '@wtfalch/reporting';
import { createHousekeeping, pruneEvents, retentionLag } from '@wtfalch/reporting/housekeeping';
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

## Shutdown

```ts
import { registerShutdownFlush } from '@wtfalch/reporting/next';
registerShutdownFlush(reporting);   // one bounded flush on SIGTERM
```

Best effort. The queue is per process and bounded at 1,000; the logger has
every row regardless.

## Analytics (0.2.0)

Three tables and two writers. `reporting_analytics` holds raw rows for a
window (`analytics.retention_days`, default 90); `reporting_analytics_daily`
and `reporting_analytics_weekly` hold counts with no identifier in any column
and are kept indefinitely. The rollups store distinct visitor and people
counts at every grain a reader asks for (site, tenant, name, path, device,
country, referrer) rather than summing finer groups, keep a contiguous
completed-day watermark in `reporting_tasks`, and pruning never passes what
they still need.

```ts
// The collector, a public route: POST and OPTIONS, always 204.
import { collectHandler } from '@wtfalch/reporting/next';
const handle = collectHandler({
  reporting, db,
  sites: JSON.parse(process.env.REPORTING_SITES ?? '{}'),
  getUserId: async () => (await getSession())?.user.id ?? null,
  tenantFor: async (userId, path) => tenantIfMember(userId, path),
  normalisePath: routePattern,
});
export const POST = handle;
export const OPTIONS = handle;

// The beacon, in the root layout.
import { ReportingProvider, ConsentControl } from '@wtfalch/reporting/react';
<ReportingProvider collector="/api/reporting/collect" site="app" consent="consented">
  {children}
  <ConsentControl>We count visits. Allow a cookie so we can tell returning visitors apart?</ConsentControl>
</ReportingProvider>

// Server-side truth, from a Server Action.
await reporting.analytics.track({ name: 'invoice.approved', userId: access.actor.id, tenantId, path });

// Housekeeping.
housekeeping.register(rollupAnalytics);
housekeeping.register(rollupAnalyticsWeekly);
housekeeping.register(pruneAnalytics);
```

What the beacon never sends: a user id. Identity is joined server-side from
the session, for same-origin beacons only; a beacon from an allowed foreign
origin (`sites`) is recorded with no user and no tenant, whatever cookies it
carries. Paths are normalised to route patterns before storage
(`normalisePath`: uuids, numbers, tokens and addresses become placeholders),
the query string never arrives, the user agent becomes a device class and is
discarded, and `cf-ipcountry` becomes two letters or nothing.

Consent: `none` stores nothing about the browser; `consented` (the default)
sets the first-party cookie `_rp` only after `accept()`; `always` sets it
without asking. `analytics.identify_signed_in` is the one line that turns
server-side identification off.

Erasure: `reporting_erase_person(subject)` deletes the subject's raw rows;
the rollups hold nothing to erase. Call it in the host's erasure transaction.

## Tests

```ts
import { createFakeReporting } from '@wtfalch/reporting/fake';
```

Same validation, no database; `fake.rows` is the table.

## What this package never does

Read a request or a session, decide a permission, connect to a database of
its own, import `next` from the core, or store an ip, a user agent, an
email address or a display name. See `PRIVACY.md`.
