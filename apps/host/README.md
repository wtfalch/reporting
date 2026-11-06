# @wtfalch/reporting-host

A company's reporting backend: one Next app per company, deployed by foundry
at `https://reporting.<domain>`, or `https://<slug>-reporting.oikos.host` for
a company without a domain (docs/adr/0002-one-backend-and-app-per-company.md,
slice 4 of docs/plans/backend.md). Private, never published.

It is wtfalch/analytics' `apps/host`, copied: the same composition root,
migrate script, runtime-role check, health route and image. It mounts
`@wtfalch/reporting-service`'s handler at `/v1/*`; the routes and their
answers are in that package's README and in the plan's contract. There are
no screens yet: `/` is a placeholder, and Boule shows a company's errors
first.

## Environment, for foundry

| Variable | Secret | Required | What it is |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes (holds a password) | yes | The runtime role's URL. `migrate.mjs` creates or syncs this role from the URL itself (user and password), every boot. The server connects as it: pool of 5, 15 s statement timeout, `search_path` `reporting, public`. Must name a different role from the owner. |
| `DATABASE_URL_OWNER` | yes | yes | The owner's URL, same database. Used by `migrate.mjs` only; `start.sh` removes it before the server starts. The owner URL must carry a password. |
| `REPORTING_OPERATOR_KEY` | yes | yes, in effect | The operator bearer: site-key mint and revoke, and every error read and state change. foundry generates it and gives the same value to Boule. Unset or empty, every operator route answers 401 and the host logs a warning at boot. |
| `AUTH_ORGANIZATION_ID` | no | yes, in effect | The company's sign-in organisation. Its tenant id (`tenantIdOf`) goes on every key and row. Unset, a mint answers 503 `not_configured` and the host logs a warning at boot. |
| `MAIL_FROM` | no | for error emails | The From line of the company's error emails, an address or `Name <address>`. Unset, no error email is sent and the host logs a warning at boot. |
| `LETTERMINT_API_TOKEN` | yes | for error emails | The company's Lettermint token (the `<slug>-app` project, as an app's `uses.mail` gets it). Redacted from every stored report. |
| `MAIL_SINK_URL` | no | stage only | A Mailpit sink; wins over the token, so a stage host never reaches the provider. |
| `MAINTENANCE` | no | no | `true` makes `/api/health` answer 200 with `maintenance: true` even when the database check fails. |
| `APP_VERSION` | no | no | Set by the image from Coolify's `SOURCE_COMMIT` build arg; `/api/health` reports it. |
| `NODE_ENV`, `PORT`, `HOSTNAME` | no | set by the image | `production`, `3000`, `0.0.0.0`. Any `NODE_ENV` other than exactly `development` or `test` is production. |

The ingest redacts `REPORTING_OPERATOR_KEY`'s, `DATABASE_URL`'s and `LETTERMINT_API_TOKEN`'s values,
and the estate's `KEYSTORE_*`, from every stored report. Nothing here logs a
key, a secret or an error's text: a failure is logged as fixed text and the
error's name.

The variable names are analytics' host's with `REPORTING` in place of
`ANALYTICS`. The analytics host's `AUTH_ISSUER`, `AUTH_CLIENT_ID` and
`APP_URL` are for its screens; this host reads none of them until it has
screens.

## Routes

- `/v1/*`: the service (`POST /v1/site-keys`, `DELETE /v1/site-keys/:id`,
  `POST /v1/errors`, `GET /v1/errors`, `GET /v1/errors/series`,
  `GET /v1/errors/:fingerprint`, `POST /v1/errors/:fingerprint/state`,
  `GET` and `PUT /v1/alert-rules`, `POST /v1/releases`).
  Every request is refused with `503 unavailable` until the connected role
  passes the runtime-role check.
- `/api/health`: `{ ok, service: 'reporting-host', version, checks: [{ name:
  'database', ok }] }`, 200 or 503. The database check is the runtime-role
  check (cached once it has a verdict) and a fresh `select 1` with a 3 s
  deadline; a 503 never says why.
- Each `/api/health` call also ticks core's housekeeping after the answer
  (at most once a minute per process): `reporting.prune_events`,
  `reporting.retention_lag`, `reporting.prune_errors` and
  `reporting.prune_open_errors`. The first tick writes
  `events.retention_days` = 90 if the table holds no row for it; an existing
  row, whatever its value, is left alone.
- Each `/api/health` call and each accepted `POST /v1/errors` batch also
  ticks the error emails after the answer (at most once a minute per
  process; the service README, "Error emails"). Coolify's health check runs
  every 30 seconds, so a mail goes out within about a minute.

## Migrations and the runtime role

`scripts/start.sh` is the image's entrypoint. It runs `scripts/migrate.mjs`,
then `exec`s the server without `DATABASE_URL_OWNER`. `migrate.mjs`, as the
owner, into schema `reporting`:

1. applies core's migrations (`reporting`), then the service's
   (`reporting-service`), then this host's own `drizzle/*.sql` (`host`,
   none yet), each under its own name in one ledger,
   `reporting._migrations_sources`, under one advisory lock;
2. creates or syncs the runtime role with `ensureRuntimeRole`, holding it to
   the service README's grants (`scripts/runtime-grants.mjs`):
   - `audit_events` and `reporting_events`: SELECT and INSERT only;
   - `reporting_site_keys`, `reporting_alert_rules`, `reporting_releases`,
     `reporting_alerts` and core's six tables (`reporting_tasks`,
     `reporting_settings`, `reporting_errors`, `reporting_tenant_settings`,
     `reporting_error_tenants`, `reporting_requests`): no DELETE or
     TRUNCATE;
   - EXECUTE on core's three prune functions; never on the four analytics
     functions core's old migrations still create.

The server checks the same lists over its own connection before it serves
(`src/lib/runtime-role-guard.ts`, `assertRuntimeRole`), and refuses a
superuser, a role with BYPASSRLS and a role that owns anything. analytics
ADR 0014 has the incident behind both halves, and analytics ADR 0015 the rule
that a migration only adds.

## Image

The root `Dockerfile`: a builder that installs with the frozen lockfile and
runs `pnpm build`, and a runner with Next's standalone output plus what
`migrate.mjs` needs on disk (`@wtfalch/db` with `postgres` and
`postgres-array`, and the `migrations-dir` module, `package.json` and SQL of
core and the service). Build target `runner`; health check on `/api/health`.

## Tests

`pnpm test` runs the composition root, the guard, the production routes end
to end on PGlite, and the pool options. With `TEST_DATABASE_URL` (a Postgres
superuser URL with a password) it also runs `migrate.mjs` as a subprocess on
a fresh database and serves through the role it made, and checks the grants,
the SECURITY DEFINER lists and their `search_path`.
