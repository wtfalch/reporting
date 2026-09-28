# The shared collector — slice plan

Tracks issue #42. `docs/adr/0001-shared-collector-service-shape.md` decided
the shape; this is the sequence that gets there. Each slice is sized for one
PR under 800 changed lines outside generated files, and each one must be
independently mergeable to `main`.

## Design points ADR 0001 leaves to here

1. **Organisation id is mandatory on every row.** `eventInputSchema.tenantId`
   and the analytics writer's `tenantId` are both `.nullish()` today
   (`packages/reporting/src/schema.ts`). Once every row lives in one shared
   store, a row with no organisation id has nowhere to belong — no company's
   slice can claim it, and it cannot appear in Archon's totals either. The
   ingest schema drops `.nullish()` on `tenantId`; a write with no caller
   organisation (the host's own housekeeping, say) is the host's own
   explicit sentinel, never an absent column.

2. **Forced RLS on every table, with a test that fails when a table lacks
   it.** The `cms` pattern is the concrete model (`cms` ADR 0012,
   `packages/service/src/org-scope.ts`'s `withOrganisation`,
   `0008_cms_rls.sql`): `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL
   SECURITY` + one policy, `organisation_id = NULLIF(current_setting
   ('reporting.organisation_id', true), '')`, covering `USING` and `WITH
   CHECK` alike, so an unscoped or wrong-scoped connection matches zero rows
   on a read and as the target of a write. `withOrganisation(db,
   organisationId, work)` is the one choke point every store function goes
   through — `organisationId` always from the verified caller context, never
   a client-supplied field. The guard test (`cms`'s
   `apps/host/drizzle/0012_cms_0008_cms_rls.test.ts`) applies every
   migration into a fresh schema and asserts, from `pg_class`/`pg_policy`,
   that every table with an `organisation_id` column has `relrowsecurity`,
   `relforcerowsecurity` and at least one policy — a future table that
   forgets it fails by shape, not by a list someone has to remember to
   update. `reporting_analytics_daily`/`_weekly` hold no visitor or person
   identifier in any column (by design, for indefinite retention) but they
   do carry `tenant_id`, so the isolation policy applies to them exactly
   like every other table — "no identifier" is a column property, not an
   exemption from isolation.

   Paths that legitimately cross organisations, mirroring `cms` ADR 0012's
   own list: the prune and rollup housekeeping tasks (point 7 below), which
   must consider every organisation's due rows in one run. Each becomes a
   `SECURITY DEFINER` function returning only the organisation ids with due
   work — the same shape as `cms_due_organisations` — with the row-by-row
   work still done inside `withOrganisation`, one organisation at a time.

3. **A batch ingest endpoint with a bounded local buffer in the writer.**
   `event()` and `analytics.track()` today write straight to the bound `db`
   and flush after the unit of work or on a timer — a same-process,
   same-database call, and `event()` never throws in production
   (`packages/reporting/README.md`'s "Write" section). Over HTTP to a shared
   host, the writer keeps that never-fails-a-request contract by batching
   rows client-side and POSTing them, bounded at the existing per-process
   cap (the `queueLimit` default of 1,000 in
   `packages/reporting/src/types.ts` is the number to carry over) — a slow or unreachable collector degrades to
   dropped rows plus a logger error, never a blocked caller.

4. **Keys-issued credentials.** Every app's SDK client authenticates to the
   host with a `@wtfalch/keys`-issued credential — the `files`/`ai` pattern
   (`apps/host/src/lib/keys/*`, verified at the request boundary before any
   organisation is resolved) — never a shared static secret.

5. **Org-scoped readers plus an operator scope for Archon's totals.**
   `reporting.events.page()` applies no permission today ("Gate in your
   page," the README says). Once one store answers every organisation's
   queries, the SDK's ordinary reader takes the caller's organisation id and
   scopes by it — an ordinary Boule call. Archon's totals read is a
   *separate* call, gated by a distinct operator permission at the host,
   never the same code path with the organisation check made optional.

6. **The `./react` readers move behind the SDK.** `packages/reporting/src/
   react`'s `ReportingProvider`/`ConsentControl` beacon posts straight to the
   app's own `/api/reporting/collect` route today. Once ingest is the shared
   host, the component is told the shared host's collector URL instead —
   the same shape `sites`/`tenantFor` already thread a per-app config
   through `collectHandler` today, just pointed at a different origin. The
   component's own behaviour (consent, path normalisation, no user id ever
   leaving the browser) does not change.

7. **Prune and rollups run once, in the collector.** Every app's own
   `housekeeping.register(pruneEvents)` / `rollupAnalytics*` /
   `rollupAnalyticsWeekly` calls retire once the shared host runs them
   itself, on its own tick, against every organisation via the `SECURITY
   DEFINER` due-organisations functions from point 2 — an app no longer
   owns retention for data it no longer stores.

8. **Migration path for apps with per-app tables today.** Every app that has
   already run `reporting-migrations` has its own `reporting_events`/
   `reporting_analytics*`/`reporting_errors` tables and history; nothing here
   is a flag-day cutover or a data-migration job in this PR — that is slice
   8 below, once the host exists and has shipped. The near-term rule, stated
   in issue #42's own closing line: an app that has not yet run
   `reporting-migrations` should wait for the SDK's HTTP client rather than
   adopting more of the per-app schema now — every table an app adopts today
   is data that has to move later.

## Slices, in order

1. **This PR.** `docs/adr/0001-shared-collector-service-shape.md`, this
   plan. No code change. Done-check: `pnpm check` exits 0.

2. **Bootstrap to the service shape.** Run package-template's `pnpm
   bootstrap --shape service` (or its manual equivalent) to split
   `packages/reporting` into `packages/sdk` + `packages/service`, and
   scaffold `apps/host`. This provisions real Coolify infrastructure
   (project, application, Postgres, tunnel) and DNS — a live-system
   mutation, so it needs William's go-ahead before it runs, not only a green
   gate. Everything below assumes this exists. Done-check: `pnpm check`
   exits 0 with the new workspace layout; `apps/host` builds.

3. **Schema: organisation id mandatory, forced RLS, the guard test.** Port
   `reporting_events`/`reporting_tasks`/`reporting_settings`/
   `reporting_tenant_settings`/`reporting_analytics`/
   `reporting_analytics_daily`/`reporting_analytics_weekly`/
   `reporting_errors` into `packages/service/src/migrations`,
   `organisation_id` becomes `NOT NULL` on every row-holding table, add
   `ENABLE`/`FORCE ROW LEVEL SECURITY` plus one policy per table (point 2),
   add `org-scope.ts`'s `withOrganisation`, and the RLS guard test (the
   `cms` `0012_cms_0008_cms_rls.test.ts` shape) plus an isolation suite (two
   organisations, cross-read and cross-write both rejected, the `cms`
   `rls.test.ts` shape). Done-check: `pnpm check` exits 0;
   `TEST_DATABASE_URL=... pnpm check` exits 0 too (the RLS suite only runs
   against real Postgres — PGlite has no second, non-superuser role to be);
   the guard test is proven to fail first, against a throwaway table with no
   policy, before that table is removed and the PR is opened.

4. **Batch ingest endpoint + bounded writer buffer.** `packages/service`'s
   `POST /v1/ingest` (batch), a keys-issued credential check, a per-
   organisation RLS-scoped insert; `packages/sdk`'s writer buffers and
   flushes in batches, bounded, never throwing in production on a slow or
   unreachable host (the same contract `event()` already has). Done-check:
   `pnpm check` exits 0; a writer test proves the buffer drops past its
   bound rather than blocking; a service test proves a batch cannot plant a
   row under an organisation id other than the credential's own.

5. **Readers: org-scoped, plus an operator scope.** `packages/sdk`'s
   `events.page()`/`analytics.*` read calls go over HTTP, scoped to the
   caller's organisation; a separate operator-scoped read (Archon's totals)
   lives at the host, gated by its own distinct permission. Done-check:
   `pnpm check` exits 0; a test proves an org-scoped read never returns
   another organisation's row even when asked for one by id, and a
   non-operator caller is refused the totals read.

6. **`./react` beacon points at the shared host.** `ReportingProvider`/
   `ConsentControl` take the shared collector's URL as a prop instead of
   assuming a same-app route; the one app (or `app-template`) that wires it
   today updates its own binding, as a separate PR in that repo. Done-check:
   `pnpm check` exits 0 in `reporting`; the consuming app's own PR is its own
   done-check, not this repo's gate.

7. **Prune and rollups run in the collector.** Move
   `pruneEvents`/`pruneAnalytics`/`rollupAnalytics`/`rollupAnalyticsWeekly`/
   `retentionLag` housekeeping registration from "every app's own health
   tick" to the host's own tick, iterating every organisation via the
   `SECURITY DEFINER` due-organisations functions from point 2. Done-check:
   `pnpm check` exits 0; a test proves one tick run processes more than one
   organisation and never touches organisation B's watermark while claiming
   organisation A's task.

8. **Migration path doc + first app cutover.** Once slices 2-7 are live and
   released, write the per-app migration doc (the env var that points an
   app's SDK at the shared host, and whether an app's existing per-app rows
   are archived in place or backfilled), then cut the first consuming app
   over as its own PR in that app's repo — not this one. Done-check: that
   app's own gate, plus a read against the shared host returning that app's
   own pre-cutover history if backfilled.

Slices 2-7 are all in `wtfalch/reporting`; slice 8 is partly cross-repo.
None of 3-7 splits usefully smaller without leaving row-level security or
the write path half-built for a stretch, which costs more than one
self-contained PR each.
