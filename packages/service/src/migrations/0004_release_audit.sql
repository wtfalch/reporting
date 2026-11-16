-- @wtfalch/reporting-service: the operator write `POST /v1/releases`
-- now writes an audit_events row in the same transaction, like a mint, a
-- revoke, a state change and a rule save. Additive: one more operation the
-- audit log accepts, and two nullable columns for the environment and the
-- release the row is about.
alter table audit_events add column if not exists environment text;
alter table audit_events add column if not exists release text;
alter table audit_events drop constraint if exists audit_events_environment_check;
alter table audit_events add constraint audit_events_environment_check
  check (environment is null or environment in ('production', 'stage'));
alter table audit_events drop constraint if exists audit_events_release_check;
alter table audit_events add constraint audit_events_release_check
  check (release is null or length(release) between 1 and 128);
alter table audit_events drop constraint if exists audit_events_operation_check;
alter table audit_events add constraint audit_events_operation_check
  check (operation in ('site_key.mint', 'site_key.revoke', 'error.state', 'alert_rule.set', 'release.recorded'));
