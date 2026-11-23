# 0003 — Forced row-level security in the company database

Status: accepted, 2026-11-22. Supersedes [0002](0002-one-backend-and-app-per-company.md)
in part: its decision to drop row-level security.

## Context

ADR 0002 dropped forced row-level security (RLS) because one database serves
one company, so the database already isolates the data.

The estate's rule is stronger than that: every table that holds a tenant's
rows is bound to the tenant by the database itself, whatever the deployment
shape. A bug in a query, a helper that forgets a `where`, or a second tenant
that arrives some day must not be able to read or write another tenant's rows.

## Decision

- Every core table that holds tenant rows has `ENABLE` and `FORCE ROW LEVEL
  SECURITY` and a policy on `tenant_id` (core migration
  `0012_tenant_policies.sql`). A row with a null `tenant_id` belongs to no
  customer (a site-wide visit, a service event, an error with no tenant) and
  stays visible and writable. The three tables with no tenant rows are on
  `GLOBAL_CORE_TABLES`, each with its reason; a test fails for a table that
  has neither a policy nor a place on the list.
- One database per company stays. The tenant is the host's one tenant,
  `tenantIdOf(AUTH_ORGANIZATION_ID)`.
- The service reaches the database only through `inTenant`, a transaction
  whose first statement is `set_config('app.tenant_id', <tenant>, true)`. The
  type `TenantDb` can only be made by it, so a call with a bare `Db` does not
  compile.
- The policy is the second line. The host's own checks (the operator key, the
  site key, the mint refusing a second tenant) stay the first.

## Costs

- Every query runs in a short transaction that sets the tenant.
- A host with no tenant refuses every request that touches the database
  (`not_configured`, 503): under forced RLS an unset tenant reads as empty,
  which would look like success. Housekeeping and the error emails log a line
  and do nothing.
- A superuser owner is never bound by a policy. The proof runs as a
  non-superuser owner on PGlite in the gate; production's owner role is not
  read from this repository.
- During a rolling deploy an old container sets no tenant: it sees only
  null-tenant rows and its tenant writes are refused.
