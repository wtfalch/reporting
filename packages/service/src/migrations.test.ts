import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { runMigrationSources } from '@wtfalch/db/migrate';
import { createPgliteDatabase } from '@wtfalch/db/pglite';
import { migrationsDir as coreDir } from '@wtfalch/reporting-core/migrations-dir';
import { describe, expect, it } from 'vitest';
import { migrationsDir } from './migrations-dir.js';
import { tenantIdOf } from './site-keys.js';

const A = tenantIdOf('org_a');
const B = tenantIdOf('org_b');
const SETTING = "(NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid";
const NULLABLE = `((tenant_id IS NULL) OR (tenant_id = ${SETTING}))`;
const STRICT = `(tenant_id = ${SETTING})`;

const migration = readFileSync(join(migrationsDir, '0006_tenant_policies.sql'), 'utf8');
const BEFORE = [
  '0001_site_keys.sql',
  '0002_audit_events.sql',
  '0003_alerts.sql',
  '0004_release_audit.sql',
  '0005_alerts_dropped.sql',
];

/** Core's migrations and the service's 0001-0005, with a release and an alert already written. */
async function seeded(withKey: boolean): Promise<PGlite> {
  const client = new PGlite();
  await runMigrationSources({
    owner: createPgliteDatabase(client),
    sources: [{ name: 'reporting', dir: coreDir }],
    log: () => undefined,
  });
  for (const file of BEFORE) await client.exec(readFileSync(join(migrationsDir, file), 'utf8'));
  if (withKey) {
    await client.exec(`insert into reporting_site_keys (id, name, secret_hash, site, environment, tenant_id)
      values ('key-00001', 'k', '${'a'.repeat(64)}', 'shop', 'production', '${A}')`);
  }
  await client.exec(`insert into reporting_releases (site, environment, release, since)
    values ('shop', 'production', 'old', now())`);
  await client.exec(`insert into reporting_alerts (site, environment, kind, subject, recipients, status)
    values ('shop', 'production', 'new_kind', 'old', '{}', 'sent')`);
  return client;
}

const tenants = async (client: PGlite, table: string) =>
  (await client.query<{ t: string | null }>(`select tenant_id::text as t from ${table} order by 1`))
    .rows;

describe('0006_tenant_policies.sql', () => {
  it('tenant-column-on-releases-and-alerts: rows from before take the key tenant, only through the backfill', async () => {
    const client = await seeded(true);
    // Without the backfill the column default leaves the old rows null.
    const noBackfill = migration.replace(/update reporting_(releases|alerts)[^;]*;/g, '');
    expect(noBackfill).not.toBe(migration);
    await client.exec(noBackfill);
    expect(await tenants(client, 'reporting_releases')).toEqual([{ t: null }]);
    expect(await tenants(client, 'reporting_alerts')).toEqual([{ t: null }]);

    const full = await seeded(true);
    await full.exec(migration);
    expect(await tenants(full, 'reporting_releases')).toEqual([{ t: A }]);
    expect(await tenants(full, 'reporting_alerts')).toEqual([{ t: A }]);
  });

  it('tenant-column-on-releases-and-alerts: later inserts take the setting or the explicit value, and a second run changes nothing', async () => {
    const client = await seeded(true);
    await client.exec(migration);
    await client.query("select set_config('app.tenant_id', $1, false)", [A]);
    await client.exec(`insert into reporting_releases (site, environment, release, since)
      values ('shop', 'production', 'r-default', now())`);
    await client.exec(`insert into reporting_releases (site, environment, release, since, tenant_id)
      values ('shop', 'production', 'r-a', now(), '${A}')`);
    await client.query("select set_config('app.tenant_id', $1, false)", [B]);
    await client.exec(`insert into reporting_alerts (site, environment, kind, subject, recipients, status)
      values ('shop', 'production', 'new_kind', 'new', '{}', 'sent')`);
    await client.query("select set_config('app.tenant_id', '', false)");
    const snapshot = async () =>
      JSON.stringify([
        (await client.query('select * from reporting_releases order by release')).rows,
        (await client.query('select * from reporting_alerts order by id')).rows,
        (await client.query('select policyname, cmd, qual, with_check from pg_policies order by 1'))
          .rows,
      ]);
    const rowsOf = async (table: string, key: string) =>
      (
        await client.query<{ k: string; t: string | null }>(
          `select ${key} as k, tenant_id::text as t from ${table} order by 1`,
        )
      ).rows;
    expect(await rowsOf('reporting_releases', 'release')).toEqual([
      { k: 'old', t: A },
      { k: 'r-a', t: A },
      { k: 'r-default', t: A },
    ]);
    expect(await rowsOf('reporting_alerts', 'subject')).toEqual([
      { k: 'new', t: B },
      { k: 'old', t: A },
    ]);
    const first = await snapshot();
    await client.exec(migration);
    expect(await snapshot()).toBe(first);
  });

  it('tenant-column-on-releases-and-alerts: a database with no site key leaves the column null', async () => {
    const client = await seeded(false);
    await client.exec(migration);
    expect(await tenants(client, 'reporting_releases')).toEqual([{ t: null }]);
    expect(await tenants(client, 'reporting_alerts')).toEqual([{ t: null }]);
  });

  it('tenant-column-on-releases-and-alerts: the backfill is marked and runs before row-level security is enabled', () => {
    const lines = migration.split('\n');
    const marker = '-- destructive: fills a new column only; no existing value is changed';
    const updates = lines.flatMap((l, i) => (l.startsWith('update ') ? [i] : []));
    expect(updates).toHaveLength(2);
    for (const i of updates) expect(lines[i - 1]).toBe(marker);
    const enable = lines.findIndex((l) => /enable row level security/i.test(l));
    const addColumn = lines.findIndex((l) =>
      l.startsWith('alter table reporting_releases add column'),
    );
    expect(addColumn).toBeLessThan(Math.min(...updates));
    expect(Math.max(...updates)).toBeLessThan(enable);
  });

  it('five-tables-have-the-policy: forced row-level security, with each policy command and expression', async () => {
    const client = await seeded(true);
    await client.exec(migration);
    const flags = (
      await client.query<{ name: string; rls: boolean; forced: boolean }>(
        `select relname as name, relrowsecurity as rls, relforcerowsecurity as forced from pg_class
          where relkind = 'r' and relnamespace = current_schema()::regnamespace and relrowsecurity order by 1`,
      )
    ).rows.filter((r) => r.name.startsWith('reporting_') || r.name === 'audit_events');
    const five = [
      'audit_events',
      'reporting_alert_rules',
      'reporting_alerts',
      'reporting_releases',
      'reporting_site_keys',
    ];
    expect(flags.filter((r) => five.includes(r.name))).toEqual(
      five.map((name) => ({ name, rls: true, forced: true })),
    );
    const policies = (
      await client.query<{ t: string; cmd: string; qual: string | null; check: string | null }>(
        `select tablename as t, cmd, qual, with_check as check from pg_policies
          where tablename = any($1) order by tablename, cmd`,
        [five],
      )
    ).rows;
    expect(policies).toEqual([
      { t: 'audit_events', cmd: 'INSERT', qual: null, check: NULLABLE },
      { t: 'audit_events', cmd: 'SELECT', qual: NULLABLE, check: null },
      { t: 'reporting_alert_rules', cmd: 'ALL', qual: STRICT, check: STRICT },
      { t: 'reporting_alerts', cmd: 'ALL', qual: NULLABLE, check: NULLABLE },
      { t: 'reporting_releases', cmd: 'ALL', qual: NULLABLE, check: NULLABLE },
      { t: 'reporting_site_keys', cmd: 'ALL', qual: STRICT, check: STRICT },
    ]);
  });
});
