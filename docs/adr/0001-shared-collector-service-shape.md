# 0001 — The shared collector is a service, not a shared database

## Context

Issue #42, tracking the estate decision recorded in `wtfalch/estate`'s
`DECISIONS.md` on 2026-09-28: one shared reporting collector, org-scoped like
`@wtfalch/files` and `@wtfalch/ai`. Archon reads totals across every company;
each company's own Boule reads only its own organisation's slice.

Today `reporting` is the `library` shape (package-template's own ADR 0001
lists it among the library examples). Every app calls `createReporting({ db,
... })` against its own Postgres; every table lives in that one app's own
database, and `tenantId` scopes a read only *within* that database
(`packages/reporting/README.md`'s "Topology, today"). There is no cross-app or
cross-company read today — that is exactly what the decision above changes.

The README's "Topology, target" section (added closing issue #35) already
names the destination but leaves the architecture question open: "the
shared-host change (or a lighter 'point every app's `reporting` at one app's
database' approach) is an open architecture question for whoever picks it up
next." This ADR answers it.

Two candidate shapes:

- **Shared database.** Every app keeps calling `createReporting({ db })`, but
  `db` is a connection string to one shared Postgres, distributed to every
  app that binds reporting. No HTTP boundary; each app's own credential
  connects directly to the shared tables.
- **Service.** package-template ADR 0001's `service` shape: `packages/sdk`
  (published, unchanged name `@wtfalch/reporting`), `packages/service`
  (private, `@wtfalch/reporting-service`), `apps/host` (deployed). Apps write
  and read over HTTP through the SDK.

## Decision

Service shape, not shared database.

Package-template ADR 0001: "Pick `service` the moment the implementation
holds a credential, reads other people's data, or answers HTTP." A shared
collector is, by construction, reading other apps' and other organisations'
data — that is the entire point of Archon reading totals across every
company. The shared-database alternative would hand every one of the
estate's apps a raw Postgres credential into one cluster holding every
company's event and analytics rows, with isolation enforced only by each
app's own query discipline restating `tenantId` correctly, forever — exactly
what package-template ADR 0001 rules out ("a mostly library with a bit of
server in it... the cost of being wrong in the other direction is a
credential on npm"). Here the credential is not to npm but to a shared
multi-tenant store; the failure mode is the same shape: one leaked or
careless consumer, and every organisation's data is reachable from it.

Concretely:

- `packages/sdk` — published as `@wtfalch/reporting`, the name and version
  history carry over unchanged; the write (`event`, `analytics.track`) and
  read (`events.page`, `analytics.*`) calls become an HTTP client instead of
  a direct `db` binding.
- `packages/service` — `@wtfalch/reporting-service`, private, holds the
  schema, row-level security, batch ingest, prune and rollups.
- `apps/host` — deployed on Coolify, the one place a Postgres credential and
  an organisation-scoped RLS session ever exist.

## The shared-deployment case (package-template ADR 0013)

ADR 0013 requires any service that serves every organisation from one
deployment to argue it in writing: cost, speed, usability, and why the data
allows it.

- **Cost.** A bespoke reporting database and deployed app per organisation,
  across the whole estate, is an operational bill this data does not
  justify. `files` and `ai` are already the estate's own precedent for this:
  package-template's own examples column lists them as `service` shape,
  one shared deployment each, not one per org.
- **Speed.** One place to change retention, add a rollup grain, or ship a
  schema change, instead of every app's own per-app database drifting at its
  own pace — the exact risk the README's "Topology, today" section already
  names: "every app that migrates the current tables is data that will need
  moving later."
- **Usability.** Archon's own promise — operator totals across every company
  in one read — is structurally impossible with one database per
  organisation. A shared store is what makes that read answerable at all,
  not a convenience layered on a design that already works without it.
- **Why the data allows it.** No row this package writes is a customer's own
  authored content (contrast `cms`'s documents and assets, which is why
  `cms` ADR 0013 later reversed *to* one deployment per org for that data).
  An event or analytics row is operational telemetry about how an
  organisation uses the product — closer to `files`' "a vault that must be
  one place" and `ai`'s "jobs that belong to no customer" than to
  customer-authored content. The isolation requirement is still real — one
  organisation's numbers must never answer another organisation's read —
  but that requirement asks the database to enforce it, not to be a
  separate database. Forced Postgres row-level security is exactly that
  enforcement; `docs/plans/collector.md` is where it is built, slice by
  slice.

A shared deployment that holds organisation data enforces isolation in the
database, not only in queries: `ENABLE`/`FORCE ROW LEVEL SECURITY` on every
table that carries an `organisation_id`, failing closed when no organisation
is set on the connection, with a test that fails when any such table lacks
it — the `cms` precedent (`cms` ADR 0012, `packages/service/src/org-scope.ts`'s
`withOrganisation`, `0008_cms_rls.sql`) is the concrete model this repo
copies.

## What this does not decide yet

This ADR fixes the shape and the shared-deployment case. It does not fix the
write-transport wire format, the read API surface, the exact prune/rollup
task shape once housekeeping runs centrally, or the cutover path for apps
already running the per-app tables. `docs/plans/collector.md` is the
slice-by-slice plan for those, in the order they ship.

## Consequence

- `packages/reporting` (today's library) becomes `packages/sdk` once
  bootstrapped to the service shape; `@wtfalch/reporting`'s name and 0.x
  version history carry over unchanged — this is a shape change to the same
  published package, not a rename or a new package.
- Every app currently binding `createReporting({ db })` directly against its
  own Postgres migrates to the SDK's HTTP client, one app at a time (see the
  plan's migration-path section); nothing here forces a flag-day cutover.
- Bootstrapping the service shape (`pnpm bootstrap` in a
  package-template-generated repo) provisions real Coolify infrastructure —
  project, application, Postgres, tunnel — and DNS. That is a live-system
  mutation, out of scope for this PR, and needs William's go-ahead before it
  runs (see the campaign report's Blocked section).
