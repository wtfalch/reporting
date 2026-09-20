-- @wtfalch/reporting 0.3.0: the error group table. Mirrors src/tables.ts.
--
-- One row per fingerprint (docs/plans/errors.md): an uncaught exception's
-- stack groups repeats into a count and a last-seen time instead of a
-- firehose of identical reporting_events rows. Every statement is
-- idempotent. Applied by the host's own migrate script after the host
-- copies this file into its drizzle/ directory as the next number
-- (reporting-migrations); never edited there.
--
-- Estate-shaped: the DO block at the end assumes the runtime-role convention
-- (a role named <database>_rt that owns nothing and serves the app). A host
-- without that role gets the table and no revokes take effect, which the
-- package README says plainly.

create table if not exists reporting_errors (
  fingerprint     text primary key,
  site            text not null,
  kind            text not null,
  message         text not null,
  stack           text,
  runtime         text not null,
  release         text,
  first_seen_at   timestamptz not null,
  last_seen_at    timestamptz not null,
  occurrences     bigint not null default 1,
  state           text not null default 'open',
  resolved_at     timestamptz,
  resolved_by     text,
  tenant_id       uuid,
  request_id      text,
  -- The digest that groups occurrences (docs/plans/errors.md: sha256 of the
  -- kind and the top normalised frames, truncated to 32 hex). Lower case
  -- only: two casings of the same digest must not become two groups.
  constraint reporting_errors_fingerprint_check check (fingerprint ~ '^[0-9a-f]{32}$'),
  constraint reporting_errors_site_check check (site ~ '^[a-z][a-z0-9-]{0,63}$'),
  constraint reporting_errors_message_check check (length(message) between 1 and 512),
  -- Redacted before it is queued (src/schema.ts); this bound is a second net
  -- against a pathological stack, not the redaction itself.
  constraint reporting_errors_stack_check check (stack is null or length(stack) <= 16384),
  constraint reporting_errors_runtime_check check (runtime in ('server', 'edge', 'browser')),
  constraint reporting_errors_state_check check (state in ('open', 'resolved', 'ignored')),
  -- The row exists because one occurrence created it; it can never describe
  -- zero.
  constraint reporting_errors_occurrences_check check (occurrences > 0),
  -- The upsert only ever moves this forward. If it moved backward, the count
  -- and the window it claims to describe would disagree.
  constraint reporting_errors_seen_check check (last_seen_at >= first_seen_at),
  -- Same pairing as reporting_events_actor_pair_check: who resolved it is
  -- meaningless without when, and vice versa.
  constraint reporting_errors_resolved_pair_check check ((resolved_at is null) = (resolved_by is null))
);

comment on column reporting_errors.tenant_id is
  'From the most recent sample. No foreign key and no cascade, same as reporting_events.actor_id: the group outlives the request, and erasure must not delete the count.';
comment on column reporting_errors.request_id is
  'From the most recent sample; overwritten on every occurrence, not a history.';

-- The default operator view: this site, still open, newest first. A partial
-- index because most errors end up resolved and should not cost this one.
create index if not exists reporting_errors_site_open_idx
  on reporting_errors (site, last_seen_at desc) where state = 'open';
-- The same page's state filter, switched to resolved or ignored.
create index if not exists reporting_errors_state_idx
  on reporting_errors (state, last_seen_at desc);

-- The one way rows leave reporting_errors on a timer. Unlike
-- reporting_prune_events, eligibility is state AND age, not age alone: only
-- 'resolved' or 'ignored' rows past the window are candidates. A row still
-- 'open' is NEVER a candidate here, no matter how old — an unresolved error
-- vanishing on a timer is the failure mode that makes an error tracker
-- untrustworthy, so the only way one leaves this table is an operator
-- resolving or ignoring it first, and it ageing out after. Same clamp and
-- batching shape as reporting_prune_events: the window is clamped to between
-- seven and four hundred days inside the function, and the batch is capped
-- at 5,000 so no statement holds a lock for long.
create or replace function reporting_prune_errors(retention interval, batch integer)
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
    select fingerprint from reporting_errors
     where state in ('resolved', 'ignored')
       and last_seen_at < now() - w
     order by last_seen_at, fingerprint
     limit b
  )
  delete from reporting_errors e using victims v where e.fingerprint = v.fingerprint;
  get diagnostics n = row_count;
  return n;
end
$$;
revoke all on function reporting_prune_errors(interval, integer) from public;

comment on function reporting_prune_errors(interval, integer) is
  'Deletes only resolved or ignored rows past the retention window. An open row is never a candidate, regardless of age: an unresolved error disappearing on a timer is the one failure mode that makes an error tracker untrustworthy. It leaves this table only after an operator resolves or ignores it, and then ages out.';

-- The runtime role keeps SELECT, INSERT and UPDATE: the capture path upserts
-- on repeat occurrences and an operator moves state through this table.
-- Nothing that deletes, the same as reporting_tasks and reporting_settings;
-- reporting_prune_errors runs as the function owner, not the runtime role,
-- so the grant below is execute only, same shape as reporting_prune_events.
do $$
declare
  rt text := current_database() || '_rt';
begin
  if exists (select 1 from pg_roles where rolname = rt) then
    execute format('revoke delete, truncate on reporting_errors from %I', rt);
    execute format('grant execute on function reporting_prune_errors(interval, integer) to %I', rt);
  end if;
end
$$;
