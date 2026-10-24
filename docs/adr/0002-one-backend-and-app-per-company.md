# 0002 — One backend and app per company

Status: accepted, 2026-10-24. Supersedes
[0001](0001-shared-collector-service-shape.md).

## Context

ADR 0001 chose one shared collector for every organisation, with forced
row-level security (RLS) keeping each organisation's rows apart.

William changed that on 2026-10-24. Reporting takes the same shape as
`wtfalch/analytics`: each company runs its own reporting backend and its own
reporting app. Foundry deploys both. Nothing is shared between companies.

The shared shape no longer fits:

- The estate rule is that every company runs its own services. Only AI, edge,
  keys and Archon are the platform's.
- One database per company already isolates the data. RLS was there to make
  up for sharing a database, and without sharing it has nothing to do.
- The per-company shape is already built once, in `analytics`. Reporting
  copies it instead of designing a second shape.

## Decision

Reporting has three packages, one of them published:

- `packages/sdk`, published as `@wtfalch/reporting`. A small client with no
  dependencies and no Node imports. It sends errors to the company's own
  backend and reads them back.
- `packages/service`, private, `@wtfalch/reporting-service`. The catalogue,
  site keys, ingest and read handlers, and the audit log.
- `apps/host`, private. One Next app that is both the backend (`/v1/*`) and
  the app with screens. It runs at `reporting.<domain>`, or at
  `<slug>-reporting.oikos.host` for a company without a domain.

Today's library moves to `packages/reporting` under the name
`@wtfalch/reporting-core`. It is private and never published. The service
calls it for capture, fingerprints, grouping, alerts, housekeeping and
migrations. The directory name stays.

`@wtfalch/reporting` already shipped 1.0.0 and 1.1.0 as the library. The SDK
takes the same name at 2.0.0, because it is a breaking change for anyone who
installed the library under that name.

Each company has one database. A site key is minted per consuming entry and
identifies a site and an environment. Server callers send it as a bearer
token and learn at once when it is wrong.

## What this replaces

- Shared deployment, `organisation_id` on every row, forced RLS and
  `withOrganisation`: dropped.
- Archon reading totals across every company from one store: dropped. A
  cross-company total, if wanted, is a read over each company's own backend.
- The case for a shared deployment (package-template ADR 0013) no longer
  applies, because nothing is shared.

## Consequence

- `docs/plans/collector.md` slices 3 to 8 are struck. Slices 1 and 2 stay as
  the record of what shipped.
- The build plan for the SDK, service, host and app lives with the campaign
  that carries it out, not in this ADR.
- Foundry gets a reporting step that deploys the backend and app per company
  and mints the site keys. That work is in `wtfalch/foundry`.
- Consumers of the 0.x library keep working on `@wtfalch/reporting` 1.x until
  they move to the SDK.
