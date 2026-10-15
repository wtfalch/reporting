-- @wtfalch/reporting 0.8.0: the release and color a row was written under.
-- Mirrors src/tables.ts.
--
-- A blue/green deploy runs two copies of an app against one database. The
-- host gets REPORTING_RELEASE (an image digest) and REPORTING_COLOR (blue or
-- green) from its platform, and the package stamps both on every row it
-- writes. Both are nullable: rows written before this file, and rows from an
-- app with no color, carry null. reporting_errors already has `release`.
--
-- Same shape as 0004_environment.sql: `add column if not exists` takes only a
-- catalog lock, and the CHECK goes in `not valid` then `validate constraint`
-- so the scan of a large table does not hold ACCESS EXCLUSIVE. Every
-- statement is idempotent; no backfill.

alter table reporting_events add column if not exists release text;
alter table reporting_events add column if not exists color text;
alter table reporting_events drop constraint if exists reporting_events_color_check;
alter table reporting_events add constraint reporting_events_color_check
  check (color is null or color in ('blue', 'green')) not valid;
alter table reporting_events validate constraint reporting_events_color_check;

alter table reporting_analytics add column if not exists release text;
alter table reporting_analytics add column if not exists color text;
alter table reporting_analytics drop constraint if exists reporting_analytics_color_check;
alter table reporting_analytics add constraint reporting_analytics_color_check
  check (color is null or color in ('blue', 'green')) not valid;
alter table reporting_analytics validate constraint reporting_analytics_color_check;

alter table reporting_errors add column if not exists color text;
alter table reporting_errors drop constraint if exists reporting_errors_color_check;
alter table reporting_errors add constraint reporting_errors_color_check
  check (color is null or color in ('blue', 'green')) not valid;
alter table reporting_errors validate constraint reporting_errors_color_check;
