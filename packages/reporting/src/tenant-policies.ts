/**
 * The core tables that hold no tenant rows, with why. Every other base table
 * core's migrations create has a row-level-security policy on `tenant_id`
 * (`migrations/0012_tenant_policies.sql`); `tenant-policies.test.ts` fails
 * for a table that has neither. A table with a `tenant_id` column cannot be
 * listed here.
 */
export const GLOBAL_CORE_TABLES: Record<string, string> = {
  reporting_tasks: 'job bookkeeping keyed by name: no tenant, no person',
  reporting_settings: 'site-wide settings keyed by name',
  reporting_requests: 'counts per minute and release: no tenant, no person',
};
