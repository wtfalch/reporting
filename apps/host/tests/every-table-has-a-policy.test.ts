import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { runMigrationSources } from '@wtfalch/db/migrate';
import { createPgliteDatabase } from '@wtfalch/db/pglite';
import { GLOBAL_CORE_TABLES } from '@wtfalch/reporting-core/tenant-policies';
import { migrationSources } from '@wtfalch/reporting-service/migrations-dir';
import { beforeAll, describe, expect, it } from 'vitest';

const HOST_DIR = fileURLToPath(new URL('../drizzle/', import.meta.url));

/** The service's own list of tables that hold no tenant rows: none. */
const GLOBAL_SERVICE_TABLES: Record<string, string> = {};
const GLOBAL_TABLES: Record<string, string> = {
  ...GLOBAL_CORE_TABLES,
  ...GLOBAL_SERVICE_TABLES,
};

interface Snapshot {
  tables: string[];
  withPolicy: string[];
  withTenantColumn: string[];
}

/** What is wrong with a schema, given a list of global tables. */
function problems(s: Snapshot, list: Record<string, string>): string[] {
  const found: string[] = [];
  for (const name of s.tables) {
    if (!s.withPolicy.includes(name) && !(name in list)) {
      found.push(`${name}: no policy and not on the global list`);
    }
  }
  for (const [name, reason] of Object.entries(list)) {
    if (!s.tables.includes(name)) found.push(`${name}: listed but the table does not exist`);
    else if (s.withPolicy.includes(name)) found.push(`${name}: listed but has a policy`);
    else if (s.withTenantColumn.includes(name)) {
      found.push(`${name}: listed but has a tenant_id column`);
    }
    if (reason.trim() === '') found.push(`${name}: listed without a reason`);
  }
  return found;
}

let snapshot: Snapshot;

beforeAll(async () => {
  const client = new PGlite();
  await runMigrationSources({
    owner: createPgliteDatabase(client),
    sources: [...migrationSources, { name: 'host', dir: HOST_DIR }],
    log: () => undefined,
  });
  const names = async (text: string) =>
    (await client.query<{ name: string }>(text)).rows.map((r) => r.name);
  snapshot = {
    tables: await names(
      `select c.relname as name from pg_class c
        where c.relkind in ('r', 'p') and c.relnamespace = current_schema()::regnamespace
          and c.relname <> '_migrations_sources' order by 1`,
    ),
    withPolicy: await names(
      'select distinct tablename as name from pg_policies where schemaname = current_schema()',
    ),
    withTenantColumn: await names(
      `select table_name as name from information_schema.columns
        where table_schema = current_schema() and column_name = 'tenant_id'`,
    ),
  };
});

describe('one-test-over-the-whole-schema', () => {
  it('one-test-over-the-whole-schema: every base table has a policy or a reasoned place on the global list', () => {
    expect(snapshot.tables).toContain('reporting_releases');
    expect(snapshot.tables).toContain('reporting_events');
    expect(problems(snapshot, GLOBAL_TABLES)).toEqual([]);
  });

  it('one-test-over-the-whole-schema: the five service tables have a policy', () => {
    for (const name of [
      'reporting_site_keys',
      'audit_events',
      'reporting_alert_rules',
      'reporting_releases',
      'reporting_alerts',
    ]) {
      expect(snapshot.withPolicy).toContain(name);
    }
  });

  const fixture: Snapshot = {
    tables: ['a', 'b', 'c'],
    withPolicy: ['a'],
    withTenantColumn: ['a', 'c'],
  };

  it('one-test-over-the-whole-schema: fails for a table with no policy and not on the list', () => {
    expect(problems(fixture, { c: 'x' })).toEqual([
      'b: no policy and not on the global list',
      'c: listed but has a tenant_id column',
    ]);
  });

  it('one-test-over-the-whole-schema: fails for an entry whose table does not exist', () => {
    expect(problems({ ...fixture, tables: ['a'] }, { gone: 'why' })).toEqual([
      'gone: listed but the table does not exist',
    ]);
  });

  it('one-test-over-the-whole-schema: fails for an entry that has a policy', () => {
    expect(
      problems({ tables: ['a'], withPolicy: ['a'], withTenantColumn: [] }, { a: 'why' }),
    ).toEqual(['a: listed but has a policy']);
  });

  it('one-test-over-the-whole-schema: fails for an entry with a blank reason', () => {
    expect(problems({ tables: ['b'], withPolicy: [], withTenantColumn: [] }, { b: '  ' })).toEqual([
      'b: listed without a reason',
    ]);
  });

  it('one-test-over-the-whole-schema: fails for a listed table with a tenant_id column', () => {
    expect(
      problems({ tables: ['c'], withPolicy: [], withTenantColumn: ['c'] }, { c: 'why' }),
    ).toEqual(['c: listed but has a tenant_id column']);
  });

  it('one-test-over-the-whole-schema: lists the core global tables and no service table', () => {
    expect(Object.keys(GLOBAL_TABLES).sort()).toEqual(Object.keys(GLOBAL_CORE_TABLES).sort());
  });
});
