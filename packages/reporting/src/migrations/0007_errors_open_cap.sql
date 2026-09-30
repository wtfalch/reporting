-- @wtfalch/reporting 0.6.0: a ceiling on open error groups per site.
--
-- reporting_prune_errors (0003) never deletes an 'open' row, on purpose. But
-- the public ingest route lets an unauthenticated caller create a new group
-- per distinct message, so "never" also means "without bound". This function
-- is the bound: when a site holds more than `cap` open groups, the ones seen
-- least recently leave first. An incident that is still firing keeps its
-- group, because every occurrence moves last_seen_at forward; a flood of
-- one-off messages pushes out only other one-off messages. Idempotent.
--
-- `cap` is clamped to at least 100 so a bad argument cannot empty the table;
-- `batch` to between 1 and 5,000, same as reporting_prune_errors.
create or replace function reporting_prune_open_errors(cap integer, batch integer)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  c integer := greatest(100, coalesce(cap, 5000));
  b integer := greatest(1, least(coalesce(batch, 5000), 5000));
  n integer;
begin
  with ranked as (
    select fingerprint,
           row_number() over (partition by site order by last_seen_at desc, fingerprint) as rn
      from reporting_errors
     where state = 'open'
  ),
  victims as (
    select fingerprint from ranked where rn > c order by rn desc limit b
  )
  delete from reporting_errors e using victims v where e.fingerprint = v.fingerprint;
  get diagnostics n = row_count;
  return n;
end
$$;
revoke all on function reporting_prune_open_errors(integer, integer) from public;

comment on function reporting_prune_open_errors(integer, integer) is
  'Deletes the least recently seen open groups beyond `cap` per site. The only way an open row leaves on a timer: a bound on unauthenticated ingest, not an age limit.';

do $$
declare
  rt text := current_database() || '_rt';
begin
  if exists (select 1 from pg_roles where rolname = rt) then
    execute format('grant execute on function reporting_prune_open_errors(integer, integer) to %I', rt);
  end if;
end
$$;
