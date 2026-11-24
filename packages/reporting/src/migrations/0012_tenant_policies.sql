-- Row-level security on every core table that holds tenant rows (reporting
-- ADR 0003). A transaction binds itself to its tenant with
-- `select set_config('app.tenant_id', <uuid>, true)`; a row whose tenant_id is
-- null belongs to no customer and is visible and writable to every binding.
-- FORCE binds the table owner too, and the SECURITY DEFINER prune and rollup
-- functions run as the owner, so each command they run needs a covering
-- policy: DELETE on the four tables below, or it is denied silently.
-- Policies are dropped before they are created, so a second run changes nothing.

-- reporting_events, reporting_analytics, reporting_analytics_daily,
-- reporting_analytics_weekly: select, insert, delete. Nothing updates them.
alter table reporting_events enable row level security;
alter table reporting_events force row level security;
drop policy if exists reporting_events_tenant_select on reporting_events;
create policy reporting_events_tenant_select on reporting_events for select
  using (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
drop policy if exists reporting_events_tenant_insert on reporting_events;
create policy reporting_events_tenant_insert on reporting_events for insert
  with check (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
drop policy if exists reporting_events_tenant_delete on reporting_events;
create policy reporting_events_tenant_delete on reporting_events for delete
  using (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table reporting_analytics enable row level security;
alter table reporting_analytics force row level security;
drop policy if exists reporting_analytics_tenant_select on reporting_analytics;
create policy reporting_analytics_tenant_select on reporting_analytics for select
  using (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
drop policy if exists reporting_analytics_tenant_insert on reporting_analytics;
create policy reporting_analytics_tenant_insert on reporting_analytics for insert
  with check (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
drop policy if exists reporting_analytics_tenant_delete on reporting_analytics;
create policy reporting_analytics_tenant_delete on reporting_analytics for delete
  using (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table reporting_analytics_daily enable row level security;
alter table reporting_analytics_daily force row level security;
drop policy if exists reporting_analytics_daily_tenant_select on reporting_analytics_daily;
create policy reporting_analytics_daily_tenant_select on reporting_analytics_daily for select
  using (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
drop policy if exists reporting_analytics_daily_tenant_insert on reporting_analytics_daily;
create policy reporting_analytics_daily_tenant_insert on reporting_analytics_daily for insert
  with check (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
drop policy if exists reporting_analytics_daily_tenant_delete on reporting_analytics_daily;
create policy reporting_analytics_daily_tenant_delete on reporting_analytics_daily for delete
  using (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table reporting_analytics_weekly enable row level security;
alter table reporting_analytics_weekly force row level security;
drop policy if exists reporting_analytics_weekly_tenant_select on reporting_analytics_weekly;
create policy reporting_analytics_weekly_tenant_select on reporting_analytics_weekly for select
  using (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
drop policy if exists reporting_analytics_weekly_tenant_insert on reporting_analytics_weekly;
create policy reporting_analytics_weekly_tenant_insert on reporting_analytics_weekly for insert
  with check (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
drop policy if exists reporting_analytics_weekly_tenant_delete on reporting_analytics_weekly;
create policy reporting_analytics_weekly_tenant_delete on reporting_analytics_weekly for delete
  using (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- reporting_errors: every command; tenant_id is nullable.
alter table reporting_errors enable row level security;
alter table reporting_errors force row level security;
drop policy if exists reporting_errors_tenant on reporting_errors;
create policy reporting_errors_tenant on reporting_errors for all
  using (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- reporting_tenant_settings, reporting_error_tenants: tenant_id is not null.
alter table reporting_tenant_settings enable row level security;
alter table reporting_tenant_settings force row level security;
drop policy if exists reporting_tenant_settings_tenant on reporting_tenant_settings;
create policy reporting_tenant_settings_tenant on reporting_tenant_settings for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table reporting_error_tenants enable row level security;
alter table reporting_error_tenants force row level security;
drop policy if exists reporting_error_tenants_tenant on reporting_error_tenants;
create policy reporting_error_tenants_tenant on reporting_error_tenants for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
