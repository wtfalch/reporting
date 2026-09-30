-- @wtfalch/reporting 0.6.0: per-tenant occurrence tracking for error groups.
-- Mirrors src/tables.ts.
--
-- reporting_errors keeps one row per fingerprint, so two tenants that hit the
-- same bug share a row whose tenant_id is whichever occurrence came last.
-- That silently moves the group between tenants and gives a tenant-scoped
-- reader nothing to filter on. This table records, per fingerprint and
-- tenant, that the tenant saw the error, how often and when. Readers filter
-- and count from here when given a tenantId; the shared row is unchanged.
--
-- The foreign key cascades, so a pruned group takes its tenant rows with it
-- (the prune functions run as the table owner; the runtime role never
-- deletes). Every statement is idempotent.

create table if not exists reporting_error_tenants (
  fingerprint     text not null references reporting_errors (fingerprint) on delete cascade,
  tenant_id       uuid not null,
  occurrences     bigint not null default 1,
  first_seen_at   timestamptz not null,
  last_seen_at    timestamptz not null,
  constraint reporting_error_tenants_pkey primary key (fingerprint, tenant_id),
  constraint reporting_error_tenants_fingerprint_check check (fingerprint ~ '^[0-9a-f]{32}$'),
  constraint reporting_error_tenants_occurrences_check check (occurrences > 0),
  constraint reporting_error_tenants_seen_check check (last_seen_at >= first_seen_at)
);

create index if not exists reporting_error_tenants_tenant_idx
  on reporting_error_tenants (tenant_id, last_seen_at desc);

-- No backfill. reporting_errors holds only the latest tenant per group, so
-- copying its occurrences to that tenant would credit it with every other
-- tenant's history. Counts per tenant start at the deploy of 0.6.0.

-- Select, insert and update for the runtime role; nothing that deletes.
do $$
declare
  rt text := current_database() || '_rt';
begin
  if exists (select 1 from pg_roles where rolname = rt) then
    execute format('revoke delete, truncate on reporting_error_tenants from %I', rt);
  end if;
end
$$;
