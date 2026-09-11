-- @wtfalch/reporting 0.2.0: the analytics record. Mirrors src/tables.ts.
--
-- Three tables (docs/plans/reporting.md D13). `reporting_analytics` holds
-- raw rows for a window; the two rollups hold counts and nothing that
-- identifies anybody, which is what lets them outlive the raw rows and be
-- shown to a customer organisation. Every statement is idempotent; the file
-- is applied by the host's own migrate script after `reporting-migrations`
-- copies it in as the next number.

-- -------------------------------------------------------------- raw rows
-- No ip, no user agent, no email, no name, no free text longer than a path.
-- `user_id` is set only server-side from the session, never from the beacon;
-- `visitor_id` is the first-party cookie's value when consent gave one.
-- `path` is the pathname only, normalised to a route pattern before it gets
-- here (addendum A7), so no identifier or token survives into storage.
create table if not exists reporting_analytics (
  id              bigint generated always as identity primary key,
  occurred_at     timestamptz not null,
  received_at     timestamptz not null default now(),
  site            text not null,
  tenant_id       uuid,
  visitor_id      text,
  session_id      text,
  user_id         text,
  name            text not null,
  path            text not null,
  referrer_host   text,
  device          text not null,
  country         text,
  props           jsonb not null default '{}'::jsonb,
  schema_version  smallint not null default 1,
  constraint reporting_analytics_site_check check (site ~ '^[a-z][a-z0-9-]{0,63}$'),
  constraint reporting_analytics_name_check check (name ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$'),
  constraint reporting_analytics_path_check check (length(path) between 1 and 512 and position('?' in path) = 0),
  constraint reporting_analytics_referrer_check check (referrer_host is null or length(referrer_host) <= 253),
  constraint reporting_analytics_device_check check (device in ('desktop', 'mobile', 'tablet', 'bot', 'unknown')),
  constraint reporting_analytics_country_check check (country is null or country ~ '^[A-Z]{2}$'),
  constraint reporting_analytics_ids_check check (
    (visitor_id is null or length(visitor_id) between 8 and 64)
    and (session_id is null or length(session_id) between 8 and 64)
    and (user_id is null or length(user_id) between 1 and 256)
  ),
  -- The beacon's clock is a claim; ten minutes either side of arrival is
  -- the most it may say.
  constraint reporting_analytics_clock_check check (abs(extract(epoch from (occurred_at - received_at))) <= 600),
  constraint reporting_analytics_props_object_check check (jsonb_typeof(props) = 'object'),
  constraint reporting_analytics_props_size_check check (octet_length(props::text) <= 4096),
  constraint reporting_analytics_props_flat_check check (not jsonb_path_exists(props, 'strict $.* ? (@.type() == "object" || @.type() == "array")', '{}', true)),
  constraint reporting_analytics_props_keys_check check (
    not (props ?| array['email', 'name', 'display_name', 'displayName', 'password', 'secret', 'token', 'authorization'])
  )
);
create index if not exists reporting_analytics_site_time_idx
  on reporting_analytics (site, occurred_at desc, id desc);
create index if not exists reporting_analytics_tenant_time_idx
  on reporting_analytics (tenant_id, occurred_at desc, id desc) where tenant_id is not null;
create index if not exists reporting_analytics_user_idx
  on reporting_analytics (user_id) where user_id is not null;
create index if not exists reporting_analytics_site_name_time_idx
  on reporting_analytics (site, name, occurred_at desc);
-- The rollups read one UTC day at a time.
create index if not exists reporting_analytics_day_idx
  on reporting_analytics (((occurred_at at time zone 'UTC')::date), site);
alter table reporting_analytics set (autovacuum_vacuum_scale_factor = 0.02);

-- ------------------------------------------------------------ daily rollup
-- One row per day, site, grain and dimension value. `grain` names which
-- dimension the row is grouped by (addendum A4: distinct counts are stored
-- at every level a reader promises, never summed from finer groups):
--   site      the whole site (every dimension null)
--   tenant    per organisation
--   name      per event name
--   path      page views per normalised route, top 200 a day plus '(other)'
--   device, country, referrer   per dimension, referrers top 50 plus '(other)'
-- A day's whole set is replaced atomically by reporting_rollup_day, so a
-- bucket that leaves the top list does not linger. The generated key
-- columns make the nullable dimensions part of the primary key.
create table if not exists reporting_analytics_daily (
  day             date not null,
  site            text not null,
  grain           text not null,
  tenant_id       uuid,
  name            text,
  path            text,
  device          text,
  country         text,
  referrer_host   text,
  views           integer not null,
  visitors        integer not null,
  people          integer not null,
  tenant_key      text generated always as (coalesce(tenant_id::text, '')) stored,
  name_key        text generated always as (coalesce(name, '')) stored,
  path_key        text generated always as (coalesce(path, '')) stored,
  device_key      text generated always as (coalesce(device, '')) stored,
  country_key     text generated always as (coalesce(country, '')) stored,
  referrer_key    text generated always as (coalesce(referrer_host, '')) stored,
  constraint reporting_analytics_daily_grain_check check (grain in ('site', 'tenant', 'name', 'path', 'device', 'country', 'referrer')),
  constraint reporting_analytics_daily_pkey primary key (day, site, grain, tenant_key, name_key, path_key, device_key, country_key, referrer_key)
);
create index if not exists reporting_analytics_daily_site_grain_idx
  on reporting_analytics_daily (site, grain, day desc);

-- ----------------------------------------------------------- weekly rollup
-- Visitors and people per ISO week (the Monday), and how many of them were
-- seen in one of the four weeks before, inside the raw window: the one
-- question the daily table cannot answer.
create table if not exists reporting_analytics_weekly (
  week                date not null,
  site                text not null,
  tenant_id           uuid,
  visitors            integer not null,
  returning_visitors  integer not null,
  people              integer not null,
  returning_people    integer not null,
  tenant_key          text generated always as (coalesce(tenant_id::text, '')) stored,
  constraint reporting_analytics_weekly_pkey primary key (week, site, tenant_key)
);

-- The rollups' completed-history watermark (addendum A3), one text value
-- per task, moved in the same transaction as the aggregate set it vouches
-- for and fenced by the claim token.
alter table reporting_tasks add column if not exists watermark text;

-- Settings the next release reserved: the raw window, the consent mode and
-- the signed-in switch, per site through the key's suffix.
alter table reporting_settings drop constraint if exists reporting_settings_key_check;
alter table reporting_settings add constraint reporting_settings_key_check
  check (key ~ '^(events|analytics)\.[a-z][a-z0-9_]*$');

-- --------------------------------------------------------- reporting_rollup_day
-- Replaces one UTC day's aggregate set. Definer, because the runtime role
-- may not write the rollups directly: their contents are derived, and only
-- this function derives them. Returns the number of rows written.
create or replace function reporting_rollup_day(d date)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  n integer;
  lo timestamptz := (d::timestamp at time zone 'UTC');
  hi timestamptz := ((d + 1)::timestamp at time zone 'UTC');
begin
  if d is null then
    raise exception 'reporting_rollup_day: a day is required';
  end if;
  delete from reporting_analytics_daily where day = d;
  with raw as (
    select site, tenant_id, visitor_id, user_id, name, path, device, country, referrer_host
      from reporting_analytics
     where occurred_at >= lo and occurred_at < hi
  ),
  top_paths as (
    select site, path from (
      select site, path, count(*) as c,
             row_number() over (partition by site order by count(*) desc, path) as rn
        from raw where name = 'page.view' group by site, path
    ) t where rn <= 200
  ),
  top_refs as (
    select site, referrer_host from (
      select site, referrer_host, count(*) as c,
             row_number() over (partition by site order by count(*) desc, referrer_host) as rn
        from raw where referrer_host is not null group by site, referrer_host
    ) t where rn <= 50
  ),
  rows_out as (
    -- site
    select site, 'site' as grain, null::uuid as tenant_id, null::text as name, null::text as path,
           null::text as device, null::text as country, null::text as referrer_host,
           count(*) as views, count(distinct visitor_id) as visitors, count(distinct user_id) as people
      from raw group by site
    union all
    -- tenant
    select site, 'tenant', tenant_id, null, null, null, null, null,
           count(*), count(distinct visitor_id), count(distinct user_id)
      from raw where tenant_id is not null group by site, tenant_id
    union all
    -- name
    select site, 'name', null, name, null, null, null, null,
           count(*), count(distinct visitor_id), count(distinct user_id)
      from raw group by site, name
    union all
    -- path: page views only, top 200 plus (other)
    select r.site, 'path', null, null,
           case when tp.path is null then '(other)' else r.path end,
           null, null, null,
           count(*), count(distinct r.visitor_id), count(distinct r.user_id)
      from raw r left join top_paths tp on tp.site = r.site and tp.path = r.path
     where r.name = 'page.view'
     group by r.site, case when tp.path is null then '(other)' else r.path end
    union all
    -- device
    select site, 'device', null, null, null, device, null, null,
           count(*), count(distinct visitor_id), count(distinct user_id)
      from raw group by site, device
    union all
    -- country
    select site, 'country', null, null, null, null, coalesce(country, 'ZZ'), null,
           count(*), count(distinct visitor_id), count(distinct user_id)
      from raw group by site, coalesce(country, 'ZZ')
    union all
    -- referrer: top 50 plus (other); rows with no referrer are '(direct)'
    select r.site, 'referrer', null, null, null, null, null,
           case when r.referrer_host is null then '(direct)'
                when tr.referrer_host is null then '(other)'
                else r.referrer_host end,
           count(*), count(distinct r.visitor_id), count(distinct r.user_id)
      from raw r left join top_refs tr on tr.site = r.site and tr.referrer_host = r.referrer_host
     group by r.site, case when r.referrer_host is null then '(direct)'
                           when tr.referrer_host is null then '(other)'
                           else r.referrer_host end
  )
  insert into reporting_analytics_daily
    (day, site, grain, tenant_id, name, path, device, country, referrer_host, views, visitors, people)
  select d, site, grain, tenant_id, name, path, device, country, referrer_host,
         views::integer, visitors::integer, people::integer
    from rows_out;
  get diagnostics n = row_count;
  return n;
end
$$;
revoke all on function reporting_rollup_day(date) from public;

-- -------------------------------------------------------- reporting_rollup_week
-- Replaces one ISO week's rows (w is the Monday). Returning means seen in
-- any of the four weeks before, which is the raw lookback this rollup
-- declares; reporting_prune_analytics is told about it.
create or replace function reporting_rollup_week(w date)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  n integer;
  lo timestamptz := (w::timestamp at time zone 'UTC');
  hi timestamptz := ((w + 7)::timestamp at time zone 'UTC');
  back timestamptz := ((w - 28)::timestamp at time zone 'UTC');
begin
  if w is null or extract(isodow from w) <> 1 then
    raise exception 'reporting_rollup_week: a Monday is required';
  end if;
  delete from reporting_analytics_weekly where week = w;
  with this_week as (
    select site, tenant_id, visitor_id, user_id
      from reporting_analytics where occurred_at >= lo and occurred_at < hi
  ),
  earlier as (
    select distinct site, visitor_id, user_id
      from reporting_analytics where occurred_at >= back and occurred_at < lo
  ),
  scopes as (
    select site, null::uuid as tenant_id, visitor_id, user_id from this_week
    union all
    select site, tenant_id, visitor_id, user_id from this_week where tenant_id is not null
  )
  insert into reporting_analytics_weekly
    (week, site, tenant_id, visitors, returning_visitors, people, returning_people)
  select w, s.site, s.tenant_id,
         count(distinct s.visitor_id),
         count(distinct s.visitor_id) filter (where exists (
           select 1 from earlier e where e.site = s.site and e.visitor_id = s.visitor_id)),
         count(distinct s.user_id),
         count(distinct s.user_id) filter (where exists (
           select 1 from earlier e where e.site = s.site and e.user_id = s.user_id))
    from scopes s
   group by s.site, s.tenant_id;
  get diagnostics n = row_count;
  return n;
end
$$;
revoke all on function reporting_rollup_week(date) from public;

-- ------------------------------------------------------ reporting_prune_analytics
-- The one way raw rows leave by age. `safe_before` is the earliest day the
-- rollups still need (the daily watermark, and the weekly watermark less
-- its four-week lookback, whichever is earlier): a cutoff at or past it is
-- refused, so pruning never outruns aggregation (addendum A3).
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
    select id from reporting_analytics
     where occurred_at < cutoff
     order by occurred_at, id
     limit b
  )
  delete from reporting_analytics a using victims v where a.id = v.id;
  get diagnostics n = row_count;
  return n;
end
$$;
revoke all on function reporting_prune_analytics(interval, integer, date) from public;

-- -------------------------------------------------------- reporting_erase_person
-- The subject's raw rows go; the rollups hold no identifier and stay. Called
-- by the host inside its erasure transaction. Returns the rows deleted.
create or replace function reporting_erase_person(subject text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  n integer;
begin
  if subject is null or length(subject) = 0 then
    raise exception 'reporting_erase_person: a subject id is required';
  end if;
  delete from reporting_analytics where user_id = subject;
  get diagnostics n = row_count;
  return n;
end
$$;
revoke all on function reporting_erase_person(text) from public;

-- The runtime role inserts and reads raw rows, reads the rollups, and
-- changes either only through the functions above.
do $$
declare
  rt text := current_database() || '_rt';
begin
  if exists (select 1 from pg_roles where rolname = rt) then
    execute format('revoke update, delete, truncate on reporting_analytics from %I', rt);
    execute format('revoke insert, update, delete, truncate on reporting_analytics_daily from %I', rt);
    execute format('revoke insert, update, delete, truncate on reporting_analytics_weekly from %I', rt);
    execute format('grant execute on function reporting_rollup_day(date) to %I', rt);
    execute format('grant execute on function reporting_rollup_week(date) to %I', rt);
    execute format('grant execute on function reporting_prune_analytics(interval, integer, date) to %I', rt);
    execute format('grant execute on function reporting_erase_person(text) to %I', rt);
  end if;
end
$$;
