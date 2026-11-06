-- @wtfalch/reporting-service 0.1.0: the site keys a company's apps send
-- errors with (docs/plans/backend.md, slice 2). Applied after core's own
-- migrations: `migrationSources` lists core's source first, this one second.
--
-- One database serves one company, so every key carries that company's
-- tenant id, and minting refuses a second one (analytics ADR 0018).
--
-- Only a sha256 of the secret is stored; the secret itself is shown once, in
-- the response that mints it. A revoked key keeps its row and its revoke time.
--
-- The SQL names no role and no schema. The runtime role needs SELECT, INSERT
-- and UPDATE here (mint, revoke); nothing deletes a key.
create table if not exists reporting_site_keys (
  id          text primary key,
  name        text not null,
  secret_hash text not null,
  site        text not null,
  environment text not null,
  tenant_id   uuid not null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  constraint reporting_site_keys_secret_hash_key unique (secret_hash),
  constraint reporting_site_keys_id_check check (length(id) between 8 and 64),
  constraint reporting_site_keys_name_check check (length(name) between 1 and 128),
  constraint reporting_site_keys_hash_check check (secret_hash ~ '^[0-9a-f]{64}$'),
  constraint reporting_site_keys_site_check check (site ~ '^[a-z][a-z0-9-]{0,63}$'),
  constraint reporting_site_keys_environment_check check (environment in ('production', 'stage'))
);

-- The mint checks that no key of another company exists (`tenant_id <> $1`).
create index if not exists reporting_site_keys_tenant_idx
  on reporting_site_keys (tenant_id);
-- A mint revokes the name's older live keys.
create index if not exists reporting_site_keys_live_name_idx
  on reporting_site_keys (lower(name)) where revoked_at is null;
