# Changelog

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
