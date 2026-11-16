import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createReportingHandler } from './server.js';
import {
  SITE_KEY_SECRET_PREFIX,
  bindingOf,
  databaseSiteKeys,
  hashSecret,
  mintSiteKey,
  operatorKeyMatches,
  revokeSiteKey,
  tenantIdOf,
} from './site-keys.js';
import { type TestDb, memoryLog, testDb } from './test/db.js';

const OPERATOR = 'operator-key-for-tests';
const TENANT = tenantIdOf('org_acme');
const OTHER_TENANT = tenantIdOf('org_other');

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.exec('delete from reporting_site_keys');
});

function handler(overrides: { operatorKey?: string; tenantId?: string } = {}) {
  return createReportingHandler({
    db: t.db,
    operatorKey: OPERATOR,
    tenantId: TENANT,
    log: memoryLog(),
    ...overrides,
  });
}

function mintRequest(body: unknown, key = OPERATOR) {
  return new Request('https://reporting.test/v1/site-keys', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('tenantIdOf', () => {
  it('is a stable uuid per organisation, different per organisation', () => {
    expect(tenantIdOf('org_acme')).toBe(TENANT);
    expect(TENANT).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(OTHER_TENANT).not.toBe(TENANT);
    expect(() => tenantIdOf('')).toThrow();
  });
});

describe('operatorKeyMatches', () => {
  it('matches only the same key, whatever the lengths', () => {
    expect(operatorKeyMatches('abc', 'abc')).toBe(true);
    expect(operatorKeyMatches('abc', 'abcd')).toBe(false);
    expect(operatorKeyMatches('', 'abc')).toBe(false);
  });
});

describe('bindingOf', () => {
  it('derives the site and environment from the name, and a body that names them wins', () => {
    expect(bindingOf({ name: 'acme-shop-reporting' })).toEqual({
      site: 'acme-shop',
      environment: 'production',
    });
    expect(bindingOf({ name: 'acme-shop-stage-reporting' })).toEqual({
      site: 'acme-shop',
      environment: 'stage',
    });
    expect(bindingOf({ name: '1shop' })).toEqual({ site: 's-1shop', environment: 'production' });
    expect(bindingOf({ name: 'x', site: 'shop', environment: 'stage' })).toEqual({
      site: 'shop',
      environment: 'stage',
    });
  });
});

describe('mintSiteKey / revokeSiteKey', () => {
  it('stores only the sha256 of a ci_rk_ secret of 32 random bytes', async () => {
    const minted = await mintSiteKey(t.db, {
      name: 'shop',
      site: 'shop',
      environment: 'production',
      tenantId: TENANT,
    });
    expect(minted.secret.startsWith(SITE_KEY_SECRET_PREFIX)).toBe(true);
    expect(
      Buffer.from(minted.secret.slice(SITE_KEY_SECRET_PREFIX.length), 'base64url'),
    ).toHaveLength(32);
    const rows = await t.query('select * from reporting_site_keys');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.secret_hash).toBe(hashSecret(minted.secret));
    expect(JSON.stringify(rows)).not.toContain(minted.secret);
  });

  it('a repeat of a name revokes the older key, whatever its case', async () => {
    const first = await mintSiteKey(t.db, {
      name: 'Shop',
      site: 'shop',
      environment: 'production',
      tenantId: TENANT,
    });
    const second = await mintSiteKey(t.db, {
      name: 'shop',
      site: 'shop',
      environment: 'production',
      tenantId: TENANT,
    });
    expect(second.replaced).toEqual([first.id]);
    const resolve = databaseSiteKeys(t.db);
    expect(await resolve(first.secret)).toBeNull();
    expect(await resolve(second.secret)).toMatchObject({ id: second.id, tenantId: TENANT });
  });

  it('refuses a second tenant in one database', async () => {
    await mintSiteKey(t.db, {
      name: 'shop',
      site: 'shop',
      environment: 'production',
      tenantId: TENANT,
    });
    await expect(
      mintSiteKey(t.db, {
        name: 'other',
        site: 'other',
        environment: 'production',
        tenantId: OTHER_TENANT,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await t.query('select id from reporting_site_keys')).toHaveLength(1);
  });

  it('serialises concurrent mints of one name to one live key', async () => {
    const input = {
      name: 'shop',
      site: 'shop',
      environment: 'production' as const,
      tenantId: TENANT,
    };
    await Promise.all([mintSiteKey(t.db, input), mintSiteKey(t.db, input)]);
    const live = await t.query('select id from reporting_site_keys where revoked_at is null');
    expect(live).toHaveLength(1);
  });

  it('a revoke is idempotent and keeps the first revoke time', async () => {
    const minted = await mintSiteKey(t.db, {
      name: 'shop',
      site: 'shop',
      environment: 'production',
      tenantId: TENANT,
    });
    expect(await revokeSiteKey(t.db, minted.id)).toEqual({
      site: 'shop',
      environment: 'production',
    });
    const [before] = await t.query('select revoked_at from reporting_site_keys');
    expect(await revokeSiteKey(t.db, minted.id)).toBeNull();
    expect(await revokeSiteKey(t.db, 'unknown-id')).toBeNull();
    const [after] = await t.query('select revoked_at from reporting_site_keys');
    expect(after?.revoked_at).toEqual(before?.revoked_at);
  });
});

describe('databaseSiteKeys', () => {
  it('caches a found key, never an unknown one, and forgets a revoked one', async () => {
    let clock = 0;
    const resolve = databaseSiteKeys(t.db, { now: () => clock, ttlMs: 1000 });
    expect(await resolve('ci_rk_unknown')).toBeNull();
    const minted = await mintSiteKey(t.db, {
      name: 'shop',
      site: 'shop',
      environment: 'stage',
      tenantId: TENANT,
    });
    expect(await resolve(minted.secret)).toMatchObject({ site: 'shop', environment: 'stage' });
    await revokeSiteKey(t.db, minted.id);
    // Still cached: another process's revoke is seen up to ttlMs late.
    expect(await resolve(minted.secret)).not.toBeNull();
    clock = 2000;
    expect(await resolve(minted.secret)).toBeNull();
  });
});

describe('POST /v1/site-keys and DELETE /v1/site-keys/:id', () => {
  it('answers 201 { id, secret, site, environment } and writes a mint audit row', async () => {
    await t.exec('delete from reporting_site_keys');
    const res = await handler()(mintRequest({ name: 'acme-shop-stage-reporting' }));
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(['environment', 'id', 'secret', 'site']);
    expect(body).toMatchObject({ site: 'acme-shop', environment: 'stage' });
    const audit = await t.query(
      `select operation, tenant_id, site, key_id from audit_events where key_id = '${body.id}'`,
    );
    expect(audit).toEqual([
      { operation: 'site_key.mint', tenant_id: TENANT, site: 'acme-shop', key_id: body.id },
    ]);
  });

  it('a repeat of a name also audits the revoke of the older key', async () => {
    const h = handler();
    const first = (await (await h(mintRequest({ name: 'blog' }))).json()) as { id: string };
    await h(mintRequest({ name: 'blog' }));
    const rows = await t.query(
      `select operation from audit_events where key_id = '${first.id}' order by id`,
    );
    expect(rows.map((r) => r.operation)).toEqual(['site_key.mint', 'site_key.revoke']);
  });

  it('refuses a wrong, missing or unset operator key with 401', async () => {
    expect((await handler()(mintRequest({ name: 'x' }, 'wrong'))).status).toBe(401);
    expect((await handler({ operatorKey: '' })(mintRequest({ name: 'x' }, ''))).status).toBe(401);
    const noHeader = new Request('https://reporting.test/v1/site-keys', {
      method: 'POST',
      body: '{"name":"x"}',
    });
    const res = await handler()(noHeader);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'unauthorized', message: 'A valid credential is required' },
    });
  });

  it('answers 503 not_configured with no tenant, 400 for a bad body, 403 for a second company', async () => {
    const unconfigured = await handler({ tenantId: '' })(mintRequest({ name: 'x' }));
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual({
      error: { code: 'not_configured', message: 'Minting is not configured' },
    });
    expect((await handler()(mintRequest({ name: '' }))).status).toBe(400);
    expect((await handler()(mintRequest({ name: 'x', tenantId: TENANT }))).status).toBe(400);
    await handler()(mintRequest({ name: 'shop' }));
    const other = await handler({ tenantId: OTHER_TENANT })(mintRequest({ name: 'other' }));
    expect(other.status).toBe(403);
  });

  it('revoke answers 204, also for an unknown id, and audits only a real revoke', async () => {
    const h = handler();
    const minted = (await (await h(mintRequest({ name: 'shop' }))).json()) as {
      id: string;
      secret: string;
    };
    const del = (id: string) =>
      h(
        new Request(`https://reporting.test/v1/site-keys/${id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${OPERATOR}` },
        }),
      );
    expect((await del(minted.id)).status).toBe(204);
    expect((await del(minted.id)).status).toBe(204);
    expect((await del('no-such-key')).status).toBe(204);
    const rows = await t.query(
      `select operation from audit_events where key_id = '${minted.id}' order by id`,
    );
    expect(rows.map((r) => r.operation)).toEqual(['site_key.mint', 'site_key.revoke']);
    expect(await t.query("select 1 from audit_events where key_id = 'no-such-key'")).toEqual([]);
    // The revoked key is refused at once by this process.
    const ingest = await h(
      new Request('https://reporting.test/v1/errors', {
        method: 'POST',
        headers: { authorization: `Bearer ${minted.secret}` },
        body: JSON.stringify({ errors: [{ message: 'boom', runtime: 'server' }] }),
      }),
    );
    expect(ingest.status).toBe(401);
  });
});
