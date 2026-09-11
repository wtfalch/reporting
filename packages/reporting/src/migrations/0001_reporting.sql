-- @wtfalch/reporting: the operational event log, the housekeeping task rows
-- and the settings the housekeeping reads. Mirrors src/tables.ts.
--
-- Every statement is idempotent. Applied by the host's own migrate script
-- after the host copies this file into its drizzle/ directory as the next
-- number (reporting-migrations); never edited there.
--
-- Estate-shaped: the DO block at the end assumes the runtime-role convention
-- (a role named <database>_rt that owns nothing and serves the app). A host
-- without that role gets the tables and the function and no revokes take
-- effect, which the package README says plainly.

create table if not exists reporting_events (
  id              bigint generated always as identity primary key,
  occurred_at     timestamptz not null default now(),
  level           text not null,
  kind            text not null,
  kind_ns         text generated always as (split_part(kind, '.', 1)) stored,
  site            text not null,
  tenant_id       uuid,
  actor_class     text,
  -- An issuer or credential id. No foreign key and no cascade on purpose:
  -- rows leave this table by age through reporting_prune_events, never by
  -- erasure. That is a deliberate retention exception for a linkable
  -- identifier, written down in the host's tenancy notes, not a claim that
  -- the id is anonymous.
  actor_id        text,
  request_id      text,
  target_type     text,
  target_id       text,
  message         text not null,
  data            jsonb not null default '{}'::jsonb,
  schema_version  smallint not null default 1,
  constraint reporting_events_level_check check (level in ('info', 'warn', 'error', 'alert')),
  constraint reporting_events_kind_check check (kind ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint reporting_events_site_check check (site ~ '^[a-z][a-z0-9-]{0,63}$'),
  constraint reporting_events_actor_class_check check (actor_class is null or actor_class in ('human', 'api_key', 'agent', 'service')),
  constraint reporting_events_actor_pair_check check ((actor_id is null) = (actor_class is null)),
  constraint reporting_events_actor_id_check check (actor_id is null or length(actor_id) between 1 and 256),
  constraint reporting_events_request_id_check check (request_id is null or length(request_id) between 1 and 128),
  constraint reporting_events_target_type_check check (target_type is null or length(target_type) between 1 and 64),
  constraint reporting_events_target_id_check check (target_id is null or length(target_id) between 1 and 256),
  constraint reporting_events_target_pair_check check ((target_id is null) = (target_type is null)),
  constraint reporting_events_message_check check (length(message) between 1 and 512),
  constraint reporting_events_data_object_check check (jsonb_typeof(data) = 'object'),
  constraint reporting_events_data_size_check check (octet_length(data::text) <= 16384),
  -- Flat: no value is an object or an array. A nested payload is where a
  -- provider response or a request body sneaks in whole. `strict`, because
  -- lax mode unwraps an array before the filter sees it and would never
  -- call one an array.
  -- `silent`, so a non-object `data` fails the object check by name rather
  -- than raising 22033 from this one, whichever the planner evaluates first.
  constraint reporting_events_data_flat_check check (not jsonb_path_exists(data, 'strict $.* ? (@.type() == "object" || @.type() == "array")', '{}', true)),
  -- The keys that carry a person or a secret by name. A guardrail, not a
  -- proof: src/schema.ts refuses the same list before a row is queued, and
  -- schema.test.ts pins the two lists equal.
  constraint reporting_events_data_keys_check check (not (data ?| array['email', 'name', 'display_name', 'displayName', 'password', 'secret', 'token', 'authorization']))
);

comment on column reporting_events.actor_id is
  'An issuer or credential id. No foreign key and no cascade on purpose: rows leave by age, not by erasure.';

-- Newest first is every reader's order; the partial indexes serve the
-- filters the operator page offers without indexing what nobody asks for.
create index if not exists reporting_events_time_idx
  on reporting_events (occurred_at desc, id desc);
create index if not exists reporting_events_tenant_time_idx
  on reporting_events (tenant_id, occurred_at desc, id desc) where tenant_id is not null;
create index if not exists reporting_events_ns_time_idx
  on reporting_events (kind_ns, occurred_at desc, id desc);
create index if not exists reporting_events_problem_time_idx
  on reporting_events (occurred_at desc, id desc) where level in ('error', 'alert');
create index if not exists reporting_events_request_idx
  on reporting_events (request_id, occurred_at desc) where request_id is not null;
-- Hourly bulk deletes are the pattern the default scale factor handles badly.
alter table reporting_events set (autovacuum_vacuum_scale_factor = 0.02);

-- One row per registered housekeeping task: when it is next due, who holds
-- it now (a claim token and a lease), and how its last run ended. Claimed
-- with FOR UPDATE SKIP LOCKED in a short transaction; never with an advisory
-- lock, which is session state on whichever pooled connection served it.
create table if not exists reporting_tasks (
  task              text primary key,
  next_due_at       timestamptz not null default now(),
  last_started_at   timestamptz,
  last_finished_at  timestamptz,
  lease_expires_at  timestamptz,
  claim_token       uuid,
  last_outcome      text,
  last_error        text,
  constraint reporting_tasks_task_check check (task ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint reporting_tasks_outcome_check check (last_outcome is null or last_outcome in ('ok', 'error', 'skipped')),
  constraint reporting_tasks_error_check check (last_error is null or length(last_error) <= 512)
);

-- Operator-edited settings, one row per key. `events.*` is this release's;
-- `analytics.*` is reserved for the next.
create table if not exists reporting_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  constraint reporting_settings_key_check check (key ~ '^(events|analytics)\.[a-z][a-z0-9_]*$')
);

-- The one way rows leave reporting_events. The window is clamped to between
-- seven and four hundred days inside the function, so a caller (the app,
-- through a setting an operator edits) can shorten history to a week and no
-- further, and can never empty the table. Eligibility is by occurred_at,
-- never by an id boundary: ids do not order occurrence when two containers
-- buffer and flush independently, and a delayed insert must not make newer
-- rows eligible. Batched so no statement holds a lock for long.
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
    select id from reporting_events
     where occurred_at < now() - w
     order by occurred_at, id
     limit b
  )
  delete from reporting_events e using victims v where e.id = v.id;
  get diagnostics n = row_count;
  return n;
end
$$;
revoke all on function reporting_prune_events(interval, integer) from public;

-- The runtime role keeps SELECT and INSERT on all three tables, UPDATE on
-- tasks and settings because the claim protocol and the settings page write
-- them, and nothing that deletes. The host's default privileges granted the
-- rest at create time; the revokes here win because they run later in the
-- same file.
do $$
declare
  rt text := current_database() || '_rt';
begin
  if exists (select 1 from pg_roles where rolname = rt) then
    execute format('revoke update, delete, truncate on reporting_events from %I', rt);
    execute format('revoke delete, truncate on reporting_tasks from %I', rt);
    execute format('revoke delete, truncate on reporting_settings from %I', rt);
    execute format('grant execute on function reporting_prune_events(interval, integer) to %I', rt);
  end if;
end
$$;
