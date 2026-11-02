# One reporting backend per company — build plan

Carries out [ADR 0002](../adr/0002-one-backend-and-app-per-company.md). Written
2026-11-02, when Boule's Release 1 designs gained an Errors page for a
company's own apps (boards r1-31, r1-31b, r1-32 on the wtfalch/boule design
canvas) and nothing could read an app's errors from outside it.

The shape is `wtfalch/analytics`'s, copied rather than redesigned: a private
service package, a dependency-free SDK, one Next host per company, a database
per company, site keys minted by foundry, and an operator key for Boule. Where
this plan says "as analytics", the analytics file is the reference
(`packages/service/src/site-keys.ts`, `server.ts`, analytics ADR 0018).

## Today

- `packages/reporting` (`@wtfalch/reporting-core`, private) holds capture,
  fingerprints, grouping, redaction, alerts, housekeeping and the migrations.
  Apps that installed it as `@wtfalch/reporting` 1.x write to their own
  Postgres. Candor FX does (1.1.0, `terminal/worker/src/errors.ts`).
- `packages/sdk` (`@wtfalch/reporting` 2.0.0) is a scaffold.
- Nothing serves a company's errors over HTTP, so Boule cannot show them.

## The contract

One host per company: `https://reporting.<domain>`, or
`https://<slug>-reporting.oikos.host` for a company without a domain. Every
body is JSON; every failure is `@wtfalch/contracts`' `serviceErrorResponse`,
`{ error: { code, message } }` with its status per code, as analytics answers
(`invalid_request` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404,
`not_configured` 503, `rate_limited` 429, `unavailable` 503).

**Credentials.** `REPORTING_OPERATOR_KEY` on the host, compared in constant
time (both sides hashed, then `timingSafeEqual`); unset or empty refuses
everyone. Site keys are rows in the company's database: name, sha256 of the
secret, site, environment (`production` or `stage`), tenant, created and
revoked times. The secret is `ci_rk_` and 32 random bytes in base64url, shown
once. Every key and row carries the one tenant id derived from the company's
sign-in organisation, and minting refuses a second tenant (analytics ADR 0018).

| Route | Credential | Answer |
| --- | --- | --- |
| `POST /v1/site-keys` `{ name, site?, environment? }` | operator | `201 { id, secret, site, environment }`. A repeat of a name revokes the older key. |
| `DELETE /v1/site-keys/:id` | operator | `204`, also for an unknown id. |
| `POST /v1/errors` `{ errors: ErrorReport[] }` | site key | `202 { accepted }`. At most 20 a batch, 64 KB a body. An unknown or revoked key is `401`: a server caller learns at once (ADR 0002), and the SDK keeps no retry for it. |
| `GET /v1/errors?site&environment&state&runtime&search&limit&after` | operator | `200 { items: ErrorGroup[], next }`, newest `lastSeenAt` first, keyset-paged (`next` is an opaque cursor). `limit` 1–100, default 50. `state` defaults to `open`. |
| `GET /v1/errors/:fingerprint?site` | operator | `200 ErrorGroup`, or `404`. |
| `POST /v1/errors/:fingerprint/state` `{ site, state, by: Actor }` | operator | `200 ErrorGroup`; `404` for an unknown group. `resolved` and `ignored` stamp who and when; `open` clears both. |
| `GET /v1/errors/series?site&environment&from&to&bucket&fingerprint?` | operator | `200 { bucketMinutes, buckets: [{ start, errors }] }` from the `error.*` events. `bucket` 60 (default) or 1440; at most 31 days; every bucket present, zeros included. |

`ErrorReport`, what a sender sends — never a site, environment or tenant, which
come from the key:

```ts
{ kind?: string; message: string; stack?: string; runtime: 'server' | 'edge' | 'browser';
  release?: string; color?: 'blue' | 'green'; requestId?: string; occurredAt?: string }
```

`ErrorGroup`, what a reader gets:

```ts
{ fingerprint: string; site: string; environment: string; kind: string; message: string;
  stack: string | null; runtime: 'server' | 'edge' | 'browser'; release: string | null;
  occurrences: number; firstSeenAt: string; lastSeenAt: string;
  requestId: string | null; state: 'open' | 'resolved' | 'ignored';
  resolvedAt: string | null; resolvedBy: Actor | null }
```

The host redacts again on ingest with core's `redactPii` and its own secrets;
the sender has redacted first (Candor FX's `cleanError` removes MT5 logins and
passwords). Grouping is core's, scoped: one company backend holds every app and both
environments, and core's fingerprint (the kind and the top five frames) names
neither, so the service keys a group by `sha256(site, environment, core
fingerprint)` cut to 32 hex. The same bug in two apps, or in an app's live and
workspace copies, is two groups. A group's fingerprint therefore changes when
an app moves from writing its own database to sending; its old record is not
carried over.
`Actor` is core's `{ class, id }`; Boule sends the person who pressed the
button. Where in the app an error happened is the sender's to put in the
message or the stack, as Candor FX's `cleanError` does: core has no column for
it. A mint, a revoke and a state change each write an `audit_events` row in the
same transaction; a read writes none (Boule audits who looked).

## Slices, in order

1. **Plan** — this file. Merge first, so every later PR cites one contract.
2. **Service** (`packages/service`, `@wtfalch/reporting-service`, private):
   site keys (as analytics), the ingest calling core's capture, the reads over
   core's `errorsPage`/`errorDetail`/`setErrorState`, the series over
   `reporting_events`, the audit table, its migrations after core's. Tests on
   PGlite, and on Postgres with `TEST_DATABASE_URL`.
3. **SDK** (`packages/sdk`, `@wtfalch/reporting` 2.0.0): `createErrorSender({
   url, siteKey })` for apps (batched, bounded by a timeout, never throws,
   no Node imports so a Worker can use it), and `createErrorReader({ url,
   operatorKey })` for Boule (`list`, `get`, `setState`, `series`). No
   dependencies (analytics ADR 0003).
4. **Host** (`apps/host`): the Next app that mounts the service at `/v1/*`,
   runs the migrations with the owner credential and checks the runtime role
   (as analytics `apps/host`). Screens come later; Boule shows errors first.
5. **foundry**: a reporting step that deploys the host per company and mints a
   site key per app and environment, delivering `REPORTING_URL` and the key to
   the app, and `REPORTING_URL` and `REPORTING_OPERATOR_KEY` to Boule (as it
   does for analytics). In `wtfalch/foundry`.
6. **Boule**: `src/lib/apps/errors/` reads through the SDK's reader, gated and
   audited like the app's audit log, with a fake for `ARCHON_FAKE=1`; then the
   Errors pages from the boards. The managed installer passes the app its
   `REPORTING_URL` and site key, as it passes `ANALYTICS_URL`.
7. **Candor FX**: `errors.ts` sends through `createErrorSender` instead of
   writing its own database; the prune and the `reporting_*` grants leave its
   manifest one release later, once nothing writes there.

Slices 2, 3 and 6's reader can be built at once against the contract above;
4 needs 2, 5 needs 4, 7 needs 3 published and 5 deployed.

## What is not here

Alerts move with the service in a later slice; until then Candor FX keeps its
own webhook alert. Screens on the reporting host itself, source maps, and
moving the events log are out of this plan.
