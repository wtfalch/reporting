import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GLOBAL_CORE_TABLES } from './tenant-policies.js';
import { type TestDb, testDb } from './test/db.js';

/**
 * Core's migrations on PGlite (or a real Postgres): the seven tenant tables
 * are forced-RLS with the policies 0012 names, and every other base table is
 * on GLOBAL_CORE_TABLES with a reason.
 */

const SETTING = "(NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid";
const NULLABLE = `((tenant_id IS NULL) OR (tenant_id = ${SETTING}))`;
const STRICT = `(tenant_id = ${SETTING})`;

const EVENT_LIKE = [
  'reporting_events',
  'reporting_analytics',
  'reporting_analytics_daily',
  'reporting_analytics_weekly',
];
const TENANT_TABLES = [
  ...EVENT_LIKE,
  'reporting_errors',
  'reporting_tenant_settings',
  'reporting_error_tenants',
];

interface Snapshot {
  tables: string[];
  policies: Record<string, string[]>;
  tenantColumn: Record<string, boolean>;
}

let t: TestDb;
let snapshot: Snapshot;

async function takeSnapshot(): Promise<Snapshot> {
  // The ledger of applied migrations is not a core table.
  const tables = (
    await t.query(
      `select c.relname as name from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and n.nspname = current_schema()
          and c.relname <> '_migrations_sources'
        order by 1`,
    )
  ).map((r) => String(r.name));
  const policies: Record<string, string[]> = {};
  for (const r of await t.query(
    'select tablename as name from pg_policies where schemaname = current_schema()',
  )) {
    policies[String(r.name)] = [];
  }
  const tenantColumn: Record<string, boolean> = {};
  for (const name of tables) {
    const cols = await t.query(
      `select 1 from information_schema.columns
        where table_schema = current_schema() and table_name = '${name}' and column_name = 'tenant_id'`,
    );
    tenantColumn[name] = cols.length > 0;
  }
  return { tables, policies, tenantColumn };
}

/** What is wrong with the schema, given a list of global tables. */
function problems(s: Snapshot, list: Record<string, string>): string[] {
  const found: string[] = [];
  for (const name of s.tables) {
    const hasPolicy = name in s.policies;
    if (!hasPolicy && !(name in list)) found.push(`${name}: no policy and not on the global list`);
  }
  for (const [name, reason] of Object.entries(list)) {
    if (!s.tables.includes(name)) found.push(`${name}: listed but the table does not exist`);
    else if (name in s.policies) found.push(`${name}: listed but has a policy`);
    else if (s.tenantColumn[name]) found.push(`${name}: listed but has a tenant_id column`);
    if (reason.trim() === '') found.push(`${name}: listed without a reason`);
  }
  return found;
}

beforeAll(async () => {
  t = await testDb();
  snapshot = await takeSnapshot();
});
afterAll(async () => {
  await t.close();
});

describe('0012_tenant_policies.sql', () => {
  it('forces row-level security on the seven tenant tables and no other', async () => {
    const rows = await t.query(
      `select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and n.nspname = current_schema() and c.relrowsecurity
        order by 1`,
    );
    expect(rows.map((r) => r.name)).toEqual([...TENANT_TABLES].sort());
    for (const r of rows) {
      expect(r.rls).toBe(true);
      expect(r.forced).toBe(true);
    }
    for (const name of ['reporting_tasks', 'reporting_settings', 'reporting_requests']) {
      const [r] = await t.query(
        `select relrowsecurity as rls, relforcerowsecurity as forced from pg_class
          where relname = '${name}' and relnamespace = current_schema()::regnamespace`,
      );
      expect(r).toEqual({ rls: false, forced: false });
      expect(await t.query(`select 1 from pg_policies where tablename = '${name}'`)).toEqual([]);
    }
  });

  it('gives the four event tables select, insert and delete on the nullable tenant', async () => {
    for (const name of EVENT_LIKE) {
      const rows = await t.query(
        `select cmd, qual, with_check from pg_policies
          where schemaname = current_schema() and tablename = '${name}' order by cmd`,
      );
      expect(rows).toEqual([
        { cmd: 'DELETE', qual: NULLABLE, with_check: null },
        { cmd: 'INSERT', qual: null, with_check: NULLABLE },
        { cmd: 'SELECT', qual: NULLABLE, with_check: null },
      ]);
    }
  });

  it('gives errors one ALL policy on the nullable tenant and the two strict tables one on the tenant', async () => {
    const expected: Record<string, string> = {
      reporting_errors: NULLABLE,
      reporting_tenant_settings: STRICT,
      reporting_error_tenants: STRICT,
    };
    for (const [name, expression] of Object.entries(expected)) {
      const rows = await t.query(
        `select cmd, qual, with_check from pg_policies
          where schemaname = current_schema() and tablename = '${name}'`,
      );
      expect(rows).toEqual([{ cmd: 'ALL', qual: expression, with_check: expression }]);
    }
  });

  it('runs twice and leaves the same policies', async () => {
    const before = await t.query(
      `select tablename, policyname, cmd, qual, with_check from pg_policies
        where schemaname = current_schema() order by 1, 2`,
    );
    const { MIGRATION_SQL } = await import('./test/db.js');
    await t.exec(MIGRATION_SQL);
    const after = await t.query(
      `select tablename, policyname, cmd, qual, with_check from pg_policies
        where schemaname = current_schema() order by 1, 2`,
    );
    expect(after).toEqual(before);
  });
});

describe('every core table has a policy or a reason', () => {
  it('lists the ten core tables: seven with policies, three global', () => {
    expect(snapshot.tables).toHaveLength(10);
    expect(Object.keys(GLOBAL_CORE_TABLES).sort()).toEqual([
      'reporting_requests',
      'reporting_settings',
      'reporting_tasks',
    ]);
    expect(problems(snapshot, GLOBAL_CORE_TABLES)).toEqual([]);
  });

  it('fails for a table with no policy that is not on the list', () => {
    const { reporting_tasks: _gone, ...without } = GLOBAL_CORE_TABLES;
    expect(problems(snapshot, without)).toEqual([
      'reporting_tasks: no policy and not on the global list',
    ]);
  });

  it('fails for an entry whose table does not exist', () => {
    expect(problems(snapshot, { ...GLOBAL_CORE_TABLES, reporting_nothing: 'why' })).toEqual([
      'reporting_nothing: listed but the table does not exist',
    ]);
  });

  it('fails for an entry whose table has a policy', () => {
    expect(problems(snapshot, { ...GLOBAL_CORE_TABLES, reporting_errors: 'why' })).toEqual([
      'reporting_errors: listed but has a policy',
    ]);
  });

  it('fails for an entry with a blank reason', () => {
    expect(problems(snapshot, { ...GLOBAL_CORE_TABLES, reporting_tasks: '  ' })).toEqual([
      'reporting_tasks: listed without a reason',
    ]);
  });

  it('fails for a listed table that has a tenant_id column and no policy', () => {
    const s: Snapshot = {
      tables: [...snapshot.tables, 'reporting_new'],
      policies: snapshot.policies,
      tenantColumn: { ...snapshot.tenantColumn, reporting_new: true },
    };
    expect(problems(s, { ...GLOBAL_CORE_TABLES, reporting_new: 'why' })).toEqual([
      'reporting_new: listed but has a tenant_id column',
    ]);
  });

  it('passes a listed table with no tenant_id column', () => {
    expect(snapshot.tenantColumn.reporting_requests).toBe(false);
  });
});
