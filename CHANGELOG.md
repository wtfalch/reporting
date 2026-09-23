# Changelog

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
