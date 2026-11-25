import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashSecret, mintSiteKey, tenantIdOf } from './site-keys.js';
import { type TenantDb, inTenant } from './tenant.js';
import { type TestDb, testDb } from './test/db.js';

const A = tenantIdOf('org_a');
const B = tenantIdOf('org_b');

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
  await t.exec(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'rt') then create role rt nologin nosuperuser nobypassrls; end if;
  end $$`);
  await t.exec('grant select, insert, update on all tables in schema public to rt');
  await t.exec('grant usage, select on all sequences in schema public to rt');
  await t.exec('grant execute on function reporting_other_tenant_has_key(uuid) to rt');
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.exec('delete from reporting_site_keys');
  await t.exec(`insert into reporting_site_keys (id, name, secret_hash, site, environment, tenant_id)
    values ('00000000-0000-4000-8000-00000000000a', 'shop', '${hashSecret('a-secret')}', 'shop', 'production', '${A}')`);
});

const mintAs = (tenant: string, name: string) =>
  inTenant(t.db, tenant, async (tx) => {
    await tx.execute(sql`set local role rt`);
    return mintSiteKey(tx as TenantDb, {
      name,
      site: name,
      environment: 'production',
      tenantId: tenant,
    });
  }).then(
    () => 'minted',
    (e: { code?: string }) => e.code ?? String(e),
  );
const tenants = async () =>
  (await t.query('select tenant_id::text as t from reporting_site_keys order by 1')).map(
    (r) => r.t,
  );

describe('mintSiteKey as the non-superuser role under forced RLS', () => {
  it('refuses company B in a database holding company A key, and inserts no row', async () => {
    expect(await mintAs(B, 'blog')).toBe('forbidden');
    expect(await tenants()).toEqual([A]);
  });

  it('mints for company A', async () => {
    expect(await mintAs(A, 'blog')).toBe('minted');
    expect(await tenants()).toEqual([A, A]);
  });
});
