-- @wtfalch/reporting-service 0.2.0: error emails (wtfalch/reporting#102,
-- docs/plans/backend.md "Alerts move with the service"). Additive: three new
-- tables, and one more operation the audit log accepts.
--
-- `reporting_alert_rules`: which emails a company wants, one row per site,
--   environment and kind, written by the operator (Boule saves Errors ›
--   Settings here). `new_kind`: mail when a new kind of error first appears.
--   `went_up`: mail when errors go up after a release. `enabled_since` is
--   when the rule last went from off to on: a group first seen before it is
--   not new to anyone who asked. No row is the rule off.
--
-- `reporting_releases`: when a release went up on a site and environment, as
--   the operator says (Boule knows when a copy started running a release).
--   The went-up check counts from it; with none, from the release's first
--   error.
--
-- `reporting_alerts`: every mail the backend decided to send, one row per
--   site, environment, kind and subject (the group's fingerprint for
--   `new_kind`, the release for `went_up`). The unique key is what makes it
--   one mail per new kind and one per release, also with two hosts or two
--   ticks at once: a tick claims the row before it sends. `delivered` lists
--   the recipients that took it; `attempts` stops a failing send after a few
--   tries. It holds addresses (the company's own people, chosen by the rule)
--   and never an error's text.
--
-- The runtime role needs SELECT, INSERT and UPDATE on all three; nothing
-- deletes a row (apps/host/scripts/runtime-grants.mjs, NO_DELETE).
create table if not exists reporting_alert_rules (
  site          text not null,
  environment   text not null,
  kind          text not null,
  enabled       boolean not null,
  recipients    text[] not null default '{}',
  site_name     text,
  link          text,
  enabled_since timestamptz,
  tenant_id     uuid not null,
  updated_at    timestamptz not null default now(),
  updated_by_class text,
  updated_by_id    text,
  primary key (site, environment, kind),
  constraint reporting_alert_rules_site_check check (site ~ '^[a-z][a-z0-9-]{0,63}$'),
  constraint reporting_alert_rules_environment_check check (environment in ('production', 'stage')),
  constraint reporting_alert_rules_kind_check check (kind in ('new_kind', 'went_up')),
  constraint reporting_alert_rules_recipients_check check (cardinality(recipients) <= 20),
  constraint reporting_alert_rules_enabled_check check (not enabled or enabled_since is not null),
  constraint reporting_alert_rules_name_check check (site_name is null or length(site_name) between 1 and 100),
  constraint reporting_alert_rules_link_check check (link is null or (link ~ '^https://' and length(link) <= 2048))
);

create table if not exists reporting_releases (
  site        text not null,
  environment text not null,
  release     text not null,
  since       timestamptz not null,
  updated_at  timestamptz not null default now(),
  primary key (site, environment, release),
  constraint reporting_releases_site_check check (site ~ '^[a-z][a-z0-9-]{0,63}$'),
  constraint reporting_releases_environment_check check (environment in ('production', 'stage')),
  constraint reporting_releases_release_check check (length(release) between 1 and 128)
);
-- The went-up check reads a site's newest release.
create index if not exists reporting_releases_newest_idx
  on reporting_releases (site, environment, since desc);

create table if not exists reporting_alerts (
  id           bigint generated always as identity primary key,
  site         text not null,
  environment  text not null,
  kind         text not null,
  subject      text not null,
  recipients   text[] not null,
  delivered    text[] not null default '{}',
  status       text not null,
  attempts     integer not null default 0,
  created_at   timestamptz not null default now(),
  attempted_at timestamptz,
  constraint reporting_alerts_once unique (site, environment, kind, subject),
  constraint reporting_alerts_environment_check check (environment in ('production', 'stage')),
  constraint reporting_alerts_kind_check check (kind in ('new_kind', 'went_up')),
  constraint reporting_alerts_status_check check (status in ('sending', 'sent', 'failed')),
  constraint reporting_alerts_subject_check check (length(subject) between 1 and 128)
);
-- A tick looks for failed sends to try again.
create index if not exists reporting_alerts_failed_idx
  on reporting_alerts (attempted_at) where status <> 'sent';

-- A rule change writes an audit row with who saved it.
alter table audit_events drop constraint if exists audit_events_operation_check;
alter table audit_events add constraint audit_events_operation_check
  check (operation in ('site_key.mint', 'site_key.revoke', 'error.state', 'alert_rule.set'));
