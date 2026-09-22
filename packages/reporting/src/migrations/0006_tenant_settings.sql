-- @wtfalch/reporting 0.4.0: per-tenant retention overrides. Mirrors src/tables.ts.
--
-- Retention is one setting per deployed app today (settings.ts:
-- events.retention_days, analytics.retention_days), all-or-nothing. A
-- multi-tenant company app the factory stamps may need a longer window for
-- one customer's contract (gap issue #11) without moving the default for
-- everyone else.
--
-- A separate table, not a row in reporting_settings: that table's key is
-- its whole primary key, with no tenant dimension, and giving it one would
-- change every existing key's shape. `reporting_tenant_settings` is the
-- same idea -- one JSONB value per key, an operator's edit, a plain read on
-- every housekeeping run -- keyed by (tenant_id, key) instead. Clearing an
-- override never deletes the row (same "nothing that deletes" convention
-- as reporting_settings): it sets the value to JSON null, and the prune
-- functions below treat that exactly like no row at all. Every statement is
-- idempotent.

create table if not exists reporting_tenant_settings (
  tenant_id   uuid not null,
  key         text not null,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  constraint reporting_tenant_settings_pkey primary key (tenant_id, key),
  -- Only the two retention keys this release supports; unlike
  -- reporting_settings_key_check this is not a namespace pattern; there is
  -- exactly one thing this table does.
  constraint reporting_tenant_settings_key_check
    check (key in ('events.retention_days', 'analytics.retention_days')),
  -- JSON null (an explicit "no override") or a number in the same bounds
  -- settings.ts's RETENTION_BOUNDS enforces in TypeScript.
  constraint reporting_tenant_settings_value_check check (
    jsonb_typeof(value) = 'null'
    or (jsonb_typeof(value) = 'number' and (value #>> '{}')::numeric between 7 and 400)
  )
);

-- ---------------------------------------------------- reporting_prune_events
-- Same clamping and batching as before; the per-row window now checks this
-- tenant's override first, falling back to the site-wide one. A row with no
-- tenant_id (most of them) never joins, so it always uses the default --
-- unaffected by this migration until an operator sets an override.
create or replace function reporting_prune_events(retention interval, batch integer)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  w interval := greatest(interval '7 days', least(coalesce(retention, interval '30 days'), interval '400 days'));
  b integer := greatest(1, least(coalesce(batch, 5000), 5000));
  n integer;
begin
  with victims as (
    select e.id
      from reporting_events e
      left join reporting_tenant_settings ts
        on ts.tenant_id = e.tenant_id and ts.key = 'events.retention_days'
     where e.occurred_at < now() - (
             case when jsonb_typeof(ts.value) = 'number'
                  then greatest(interval '7 days', least((ts.value #>> '{}')::numeric * interval '1 day', interval '400 days'))
                  else w
             end
           )
     order by e.occurred_at, e.id
     limit b
  )
  delete from reporting_events ev using victims v where ev.id = v.id;
  get diagnostics n = row_count;
  return n;
end
$$;
revoke all on function reporting_prune_events(interval, integer) from public;

-- -------------------------------------------------- reporting_prune_analytics
-- Same shape: a tenant's own retention_days overrides the site-wide window,
-- still bounded by safe_before so pruning never outruns the rollups
-- (addendum A3) -- the per-tenant window is clamped the same 7-400 days
-- before comparison, so an override cannot defeat that guarantee either.
create or replace function reporting_prune_analytics(retention interval, batch integer, safe_before date)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  w interval := greatest(interval '7 days', least(coalesce(retention, interval '90 days'), interval '400 days'));
  b integer := greatest(1, least(coalesce(batch, 5000), 5000));
  cutoff timestamptz := now() - w;
  n integer;
begin
  if safe_before is null then
    raise exception 'reporting_prune_analytics: the rollups have not completed a day yet; nothing is safe to prune';
  end if;
  if cutoff >= (safe_before::timestamp at time zone 'UTC') then
    raise exception 'reporting_prune_analytics: cutoff % is not before the rollups'' watermark %', cutoff, safe_before;
  end if;
  with victims as (
    select a.id
      from reporting_analytics a
      left join reporting_tenant_settings ts
        on ts.tenant_id = a.tenant_id and ts.key = 'analytics.retention_days'
     where a.occurred_at < least(
             case when jsonb_typeof(ts.value) = 'number'
                  then now() - greatest(interval '7 days', least((ts.value #>> '{}')::numeric * interval '1 day', interval '400 days'))
                  else cutoff
             end,
             (safe_before::timestamp at time zone 'UTC')
           )
     order by a.occurred_at, a.id
     limit b
  )
  delete from reporting_analytics an using victims v where an.id = v.id;
  get diagnostics n = row_count;
  return n;
end
$$;
revoke all on function reporting_prune_analytics(interval, integer, date) from public;

-- The runtime role reads and edits overrides (an operator's settings page),
-- same shape as reporting_settings: select, insert, update, nothing that
-- deletes -- clearing an override is a value update, not a row removal.
--
-- CREATE OR REPLACE FUNCTION keeps the two prune functions' existing grants
-- (their signatures are unchanged from 0001/0002); the two re-grants below
-- are a no-op on a host that already has them and a safety net on one
-- whose grants somehow drifted, cheap either way.
do $$
declare
  rt text := current_database() || '_rt';
begin
  if exists (select 1 from pg_roles where rolname = rt) then
    execute format('revoke delete, truncate on reporting_tenant_settings from %I', rt);
    execute format('grant execute on function reporting_prune_events(interval, integer) to %I', rt);
    execute format(
      'grant execute on function reporting_prune_analytics(interval, integer, date) to %I',
      rt
    );
  end if;
end
$$;
