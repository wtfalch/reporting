-- @wtfalch/reporting 0.10.0: answer times, slow answers and sign-ins per minute.
-- Mirrors src/tables.ts.
--
-- The release-series read draws a new color against the live one by more than
-- its share of failed responses: how long answers took, how many were slow
-- (over 1000 ms) and how many sign-ins worked or failed. Four counters join
-- reporting_requests, which already holds one row per minute, site, color and
-- release. `duration_ms_sum` is the sum of the rounded duration of each timed
-- request, so a mean is the sum over `requests`; a request nobody timed adds
-- to `requests` and to nothing else. Counts only; nothing here identifies a
-- person or a request.
--
-- Additive and safe on live rows: `add column if not exists ... default 0`
-- takes only a catalog lock (no rewrite on Postgres 11 and later), existing
-- rows read as 0, and the CHECK goes in `not valid` then `validate constraint`
-- as in 0009 so the scan does not hold ACCESS EXCLUSIVE. The old app code that
-- does not write these columns keeps working: they default to 0. Every
-- statement is idempotent; no backfill.

alter table reporting_requests add column if not exists duration_ms_sum bigint not null default 0;
alter table reporting_requests add column if not exists slow bigint not null default 0;
alter table reporting_requests add column if not exists sign_ins bigint not null default 0;
alter table reporting_requests add column if not exists sign_in_failures bigint not null default 0;
alter table reporting_requests drop constraint if exists reporting_requests_timings_check;
alter table reporting_requests add constraint reporting_requests_timings_check
  check (duration_ms_sum >= 0 and slow between 0 and requests and sign_ins >= 0 and sign_in_failures >= 0) not valid;
alter table reporting_requests validate constraint reporting_requests_timings_check;
