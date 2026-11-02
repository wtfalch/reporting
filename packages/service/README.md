# @wtfalch/reporting-service

A company's own reporting backend (docs/adr/0002-one-backend-and-app-per-company.md,
slice 2 of docs/plans/backend.md). Private, never published: apps and Boule
reach it through `@wtfalch/reporting` (`packages/sdk`), and `apps/host`
mounts it.

It is the shape of `wtfalch/analytics`' service, copied: site keys minted with
an operator key, an ingest authenticated by site key, operator reads, and an
append-only audit log. Capture, redaction, fingerprints and grouping are
`@wtfalch/reporting-core`'s, unchanged, so an error keeps its fingerprint when
an app moves from writing its own database to sending here.

## Mounting it

```ts
import { createReportingHandler, tenantIdOf } from '@wtfalch/reporting-service';

const handle = createReportingHandler({
  db,                                            // drizzle over the company's database
  operatorKey: process.env.REPORTING_OPERATOR_KEY,
  tenantId: tenantIdOf(process.env.AUTH_ORGANIZATION_ID!),
});
// every request under /v1/*:
export const POST = handle, GET = handle, DELETE = handle;
```

`createReportingHandler` takes a Web `Request` and answers a `Response`. The
pieces it composes are exported too: `databaseSiteKeys`, `mintSiteKey`,
`revokeSiteKey`, `ingestErrors`, `listErrors`, `getError`, `setState`,
`errorSeries`, `writeAudit` and the tables.

## Routes

| Route | Credential | Answer |
| --- | --- | --- |
| `POST /v1/site-keys` `{ name, site?, environment? }` | operator | `201 { id, secret, site, environment }`; a repeat of a name revokes the older key |
| `DELETE /v1/site-keys/:id` | operator | `204`, also for an unknown id |
| `POST /v1/errors` `{ errors }` | site key | `202 { accepted }`; at most 20 a batch, 64 KB a body; `401` for an unknown or revoked key |
| `GET /v1/errors?site&environment&state&runtime&search&limit&after` | operator | `200 { items, next }` |
| `GET /v1/errors/:fingerprint?site` | operator | `200 ErrorGroup` or `404` |
| `POST /v1/errors/:fingerprint/state` `{ site, state, by }` | operator | `200 ErrorGroup` or `404` |
| `GET /v1/errors/series?site&environment&from&to&bucket&fingerprint` | operator | `200 { bucketMinutes, buckets }` |

Every failure is `@wtfalch/contracts`' `serviceErrorResponse`,
`{ error: { code, message } }`. `site` is required on every read;
`environment` is optional on the list and the series and filters when given.

## Migrations

`migrationSources` from `@wtfalch/reporting-service/migrations-dir` lists
core's migrations (`reporting`) and then this package's (`reporting-service`):
pass it to `@wtfalch/db/migrate`'s `runMigrationSources` with the owner
credential. The runtime role needs:

- `reporting_site_keys`: SELECT, INSERT, UPDATE.
- `audit_events`: SELECT, INSERT only. Triggers refuse UPDATE, DELETE and
  TRUNCATE for every role anyway.
- core's tables as core's README lists them.

## What it never does

It logs fixed text and error names only: never a site key, the operator key
or an error's text. It stores only the sha256 of a site key. It redacts
again on ingest with core's `redactPii`, the operator key and KEYSTORE_*
values (`heldSecrets`), and the presenting site key if a report quotes it.

## One group per fingerprint

Groups are core's: one row per fingerprint in the company's database. The
same bug in an app's `production` and `stage` is one group, and the group's
`environment` is the one it was seen in last. The list's `environment` filter
matches that last value. The series counts the timeline rows, so it does
tell the environments apart.
