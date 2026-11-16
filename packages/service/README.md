# @wtfalch/reporting-service

A company's own reporting backend (docs/adr/0002-one-backend-and-app-per-company.md,
slice 2 of docs/plans/backend.md). Private, never published: apps and Boule
reach it through `@wtfalch/reporting` (`packages/sdk`), and `apps/host`
mounts it.

It is the shape of `wtfalch/analytics`' service, copied: site keys minted with
an operator key, an ingest authenticated by site key, operator reads, and an
append-only audit log. Capture, redaction, fingerprints and grouping are
`@wtfalch/reporting-core`'s, with each group scoped to its site and
environment (see below).

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
| `GET /v1/alert-rules?site` | operator | `200 AlertRules`; a site never saved has every switch off |
| `PUT /v1/alert-rules` `{ site, name?, recipients, links?, choices, by }` | operator | `200 AlertRules`; `400` for an email that is on with no recipient; `503` with no tenant |
| `POST /v1/releases` `{ site, environment, release, since }` | operator | `200` the release as recorded; `400` for a `since` more than 5 minutes ahead |

An `ErrorGroup` carries `people`: how many different people hit it, from
the reports that named one (`ErrorReport.person`, an issuer or session id
the sender has), within event retention; `null` when none did. The id itself
is never stored: the timeline row keeps `personHash(site, environment, id)`,
32 hex.

## Error emails

`choices` is Boule's Errors › Settings exactly: `{ live: { newKind, wentUp },
work: { newKind, wentUp } }`, `live` being the `production` environment and
`work` the `stage` one. `recipients` (up to 20 addresses) get every email of
the site; `links.live` and `links.work` are where each copy's mail button
goes. `createAlerts({ db, mail, log }).tick()` decides and sends:

- **A new kind of error**: one mail per group first seen after the switch
  went on (and within a day), never per event.
- **Errors went up after a release**: one mail per release, by Boule's W5.2
  rule (`baselineOf`: normal is the median of the 8 whole UTC days before
  the release day, counted from the first day with an error, at least 3 such
  days; raised at 3 times normal and at least 10 errors). The release and
  its start come from `POST /v1/releases`; with none recorded, from the
  newest error that names a release, counted from its first error. Checked
  for 7 days after a release.

Every mail is claimed first as a `reporting_alerts` row, unique per site,
environment, kind and subject, so a second tick or host never sends it
again. A failed send is logged as fixed text (no address) and tried at most
3 times in all, 10 minutes apart.

Every failure is `@wtfalch/contracts`' `serviceErrorResponse`,
`{ error: { code, message } }`. `site` is required on every read;
`environment` is optional on the list and the series and filters when given.

## Migrations

`migrationSources` from `@wtfalch/reporting-service/migrations-dir` lists
core's migrations (`reporting`) and then this package's (`reporting-service`):
pass it to `@wtfalch/db/migrate`'s `runMigrationSources` with the owner
credential. The runtime role needs:

- `reporting_site_keys`, `reporting_alert_rules`, `reporting_releases`,
  `reporting_alerts`: SELECT, INSERT, UPDATE.
- `audit_events`: SELECT, INSERT only. Triggers refuse UPDATE, DELETE and
  TRUNCATE for every role anyway.
- core's tables as core's README lists them.

## What it never does

It logs fixed text and error names only: never a site key, the operator key
or an error's text. It stores only the sha256 of a site key. It redacts
again on ingest with core's `redactPii`, the operator key and KEYSTORE_*
values (`heldSecrets`), and the presenting site key if a report quotes it.

## One group per site, environment and fingerprint

A company's database holds every app's errors, and core's fingerprint
(the kind and the top five normalised frames) names no app. So the ingest
passes core's capture a `scope` from the site key, and a group's fingerprint
is `sha256(site + "\n" + environment + "\n" + core fingerprint)`, cut to 32
lower-case hex. Two apps that throw the same way are two groups, and so are
one app's production and stage. The `error.*` timeline rows carry the same
value, so `series?fingerprint=` counts only that group's rows. A fingerprint
implies its environment, so `GET /v1/errors/:fingerprint` and `/state` take
`site` only.

An app that wrote its own database with the 1.x library has the plain core
fingerprint. The same error has a different fingerprint here, and it starts a
new group when the app moves to sending.
