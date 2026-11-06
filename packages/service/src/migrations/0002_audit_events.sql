-- @wtfalch/reporting-service 0.1.0: the audit log for site-key mints and
-- revokes and for error state changes (docs/plans/backend.md: "A mint, a
-- revoke and a state change each write an audit_events row in the same
-- transaction; a read writes none").
--
-- Append-only. The runtime role should hold SELECT and INSERT only; the
-- triggers below refuse UPDATE, DELETE and TRUNCATE for every role, so a
-- grant made by mistake still cannot rewrite the record. It holds ids, names
-- and a fingerprint, never a secret and never an error's text.
create table if not exists audit_events (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  operation   text not null,
  tenant_id   uuid,
  site        text,
  key_id      text,
  fingerprint text,
  state       text,
  actor_class text,
  actor_id    text,
  constraint audit_events_operation_check
    check (operation in ('site_key.mint', 'site_key.revoke', 'error.state')),
  constraint audit_events_fingerprint_check
    check (fingerprint is null or fingerprint ~ '^[0-9a-f]{32}$'),
  constraint audit_events_state_check
    check (state is null or state in ('open', 'resolved', 'ignored')),
  constraint audit_events_actor_class_check
    check (actor_class is null or actor_class in ('human', 'api_key', 'agent', 'service')),
  constraint audit_events_actor_pair_check check ((actor_id is null) = (actor_class is null)),
  constraint audit_events_actor_id_check check (actor_id is null or length(actor_id) between 1 and 256)
);
create index if not exists audit_events_time_idx on audit_events (occurred_at desc, id desc);

create or replace function audit_events_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_events is append-only';
end
$$;

drop trigger if exists audit_events_no_change on audit_events;
create trigger audit_events_no_change
  before update or delete on audit_events
  for each row execute function audit_events_append_only();

drop trigger if exists audit_events_no_truncate on audit_events;
create trigger audit_events_no_truncate
  before truncate on audit_events
  for each statement execute function audit_events_append_only();
