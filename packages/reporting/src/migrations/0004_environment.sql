-- @wtfalch/reporting 0.4.0: an environment dimension on error and event
-- rows. Mirrors src/tables.ts.
--
-- Every factory app deploys prod + stage + one preview per PR, and site is
-- the app's identity, not its deploy target -- so without a second column,
-- preview noise and production issues land in the same rows with nothing to
-- tell them apart (gap issue #6). `environment` is a slug the host stamps
-- once, the way it already stamps `release`, never claimed per event.
--
-- Nullable and not fixed to an enum: unlike `level` or `runtime`, the estate
-- does not fix the set of environments a host may name, so the CHECK only
-- keeps it slug-shaped. Every statement is idempotent; the file is applied
-- by the host's own migrate script after `reporting-migrations` copies it in
-- as the next number.
--
-- `not valid` then a separate `validate constraint`, unlike
-- reporting_settings_key_check's plain add in 0002: that table is a handful
-- of rows, reporting_events and reporting_errors are the two tables this
-- package batches deletes against and tunes autovacuum for, so a CHECK added
-- the plain way would hold an ACCESS EXCLUSIVE lock for as long as it takes
-- to scan one of them. `not valid` takes that lock only for the catalog
-- change; `validate constraint` then scans under SHARE UPDATE EXCLUSIVE,
-- which blocks other DDL but not the reads and writes this package makes
-- every request.

alter table reporting_events add column if not exists environment text;
alter table reporting_events drop constraint if exists reporting_events_environment_check;
alter table reporting_events add constraint reporting_events_environment_check
  check (environment is null or environment ~ '^[a-z][a-z0-9_-]{0,31}$') not valid;
alter table reporting_events validate constraint reporting_events_environment_check;

alter table reporting_errors add column if not exists environment text;
alter table reporting_errors drop constraint if exists reporting_errors_environment_check;
alter table reporting_errors add constraint reporting_errors_environment_check
  check (environment is null or environment ~ '^[a-z][a-z0-9_-]{0,31}$') not valid;
alter table reporting_errors validate constraint reporting_errors_environment_check;
