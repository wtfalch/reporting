-- @wtfalch/reporting-service: forced row-level security on the service's five
-- tables (reporting ADR 0003; core's 0012_tenant_policies.sql does the same
-- for core's tables). A transaction binds itself with
-- `select set_config('app.tenant_id', <uuid>, true)`.
--
-- ORDER IS A RULE, in this one file (one transaction, run once): add the
-- columns, backfill, and only then ENABLE and FORCE and create the policies.
-- With FORCE on, a non-superuser owner's backfill would match no row.
--
-- `reporting_releases` and `reporting_alerts` hold the company's rows and had
-- no `tenant_id`. The default fills it from the session setting, so an old
-- container during a rolling deploy, which names no column, still writes the
-- tenant. The default is stable: Postgres evaluates it once at ALTER time for
-- existing rows (null inside a migration, no setting) and keeps the
-- expression for later inserts. The backfill alone fills the migration's rows.
-- With no site key the column stays null. Those two tables allow a null
-- tenant (rows from before the backfill, or an unbound old container).

alter table reporting_releases add column if not exists tenant_id uuid
  default nullif(current_setting('app.tenant_id', true), '')::uuid;
alter table reporting_alerts add column if not exists tenant_id uuid
  default nullif(current_setting('app.tenant_id', true), '')::uuid;

-- destructive: fills a new column only; no existing value is changed
update reporting_releases set tenant_id = (select tenant_id from reporting_site_keys order by created_at, id limit 1)
  where tenant_id is null;
-- destructive: fills a new column only; no existing value is changed
update reporting_alerts set tenant_id = (select tenant_id from reporting_site_keys order by created_at, id limit 1)
  where tenant_id is null;

alter table reporting_site_keys enable row level security;
alter table reporting_site_keys force row level security;
drop policy if exists reporting_site_keys_tenant_all on reporting_site_keys;
create policy reporting_site_keys_tenant_all on reporting_site_keys for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table reporting_alert_rules enable row level security;
alter table reporting_alert_rules force row level security;
drop policy if exists reporting_alert_rules_tenant_all on reporting_alert_rules;
create policy reporting_alert_rules_tenant_all on reporting_alert_rules for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table audit_events enable row level security;
alter table audit_events force row level security;
drop policy if exists audit_events_tenant_select on audit_events;
create policy audit_events_tenant_select on audit_events for select
  using (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
drop policy if exists audit_events_tenant_insert on audit_events;
create policy audit_events_tenant_insert on audit_events for insert
  with check (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table reporting_releases enable row level security;
alter table reporting_releases force row level security;
drop policy if exists reporting_releases_tenant_all on reporting_releases;
create policy reporting_releases_tenant_all on reporting_releases for all
  using (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table reporting_alerts enable row level security;
alter table reporting_alerts force row level security;
drop policy if exists reporting_alerts_tenant_all on reporting_alerts;
create policy reporting_alerts_tenant_all on reporting_alerts for all
  using (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
