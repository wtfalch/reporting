# Changelog

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
