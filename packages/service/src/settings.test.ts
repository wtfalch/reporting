import type { Reporting } from '@wtfalch/reporting-core';
import { createReporting } from '@wtfalch/reporting-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Permission, ReportingPrincipal } from './principal.js';
import { createSettingsHandler } from './settings.js';
import { memoryLog, testDb } from './test/db.js';
import type { TestDb } from './test/db.js';

function principalWith(...permissions: Permission[]): ReportingPrincipal {
  return { actor: { class: 'human', id: 'u1' }, permissions: new Set(permissions) };
}

let t: TestDb;
beforeEach(async () => {
  t = await testDb();
});
afterEach(async () => {
  await t.close();
});

describe('createSettingsHandler', () => {
  it('refuses a read with no principal', async () => {
    const reporting = createReporting({ db: t.db, log: memoryLog(), site: 'test', mode: 'test' });
    const handler = createSettingsHandler({ reporting, principal: null });
    const response = await handler(new Request('http://svc/settings', { method: 'GET' }));
    expect(response.status).toBe(401);
  });

  it('refuses a read without reporting:settings', async () => {
    const reporting = createReporting({ db: t.db, log: memoryLog(), site: 'test', mode: 'test' });
    const handler = createSettingsHandler({
      reporting,
      principal: principalWith('reporting:read'),
    });
    const response = await handler(new Request('http://svc/settings', { method: 'GET' }));
    expect(response.status).toBe(403);
  });

  it('reads the default site-wide settings', async () => {
    const reporting = createReporting({ db: t.db, log: memoryLog(), site: 'test', mode: 'test' });
    const handler = createSettingsHandler({
      reporting,
      principal: principalWith('reporting:settings'),
    });
    const response = await handler(new Request('http://svc/settings', { method: 'GET' }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { settings: { 'events.retention_days': number } };
    expect(body.settings['events.retention_days']).toBe(30);
  });

  it('changes a site-wide setting and rejects an out-of-bounds value', async () => {
    const reporting = createReporting({ db: t.db, log: memoryLog(), site: 'test', mode: 'test' });
    const handler = createSettingsHandler({
      reporting,
      principal: principalWith('reporting:settings'),
    });
    const put = await handler(
      new Request('http://svc/settings', {
        method: 'PUT',
        body: JSON.stringify({ 'events.retention_days': 14 }),
      }),
    );
    expect(put.status).toBe(200);
    const body = (await put.json()) as { settings: { 'events.retention_days': number } };
    expect(body.settings['events.retention_days']).toBe(14);

    const tooHigh = await handler(
      new Request('http://svc/settings', {
        method: 'PUT',
        body: JSON.stringify({ 'events.retention_days': 999999 }),
      }),
    );
    expect(tooHigh.status).toBe(400);
  });

  it('reads and sets a tenant retention override', async () => {
    const reporting = createReporting({ db: t.db, log: memoryLog(), site: 'test', mode: 'test' });
    const handler = createSettingsHandler({
      reporting,
      principal: principalWith('reporting:settings'),
    });
    const tenantId = '11111111-1111-1111-1111-111111111111';

    const empty = await handler(
      new Request(`http://svc/settings/tenants/${tenantId}`, { method: 'GET' }),
    );
    expect(empty.status).toBe(200);
    expect((await empty.json()) as { overrides: object }).toEqual({ overrides: {} });

    const put = await handler(
      new Request(`http://svc/settings/tenants/${tenantId}`, {
        method: 'PUT',
        body: JSON.stringify({ key: 'events.retention_days', days: 90 }),
      }),
    );
    expect(put.status).toBe(200);
    const body = (await put.json()) as { overrides: Record<string, number> };
    expect(body.overrides['events.retention_days']).toBe(90);

    const rejectsUnknownKey = await handler(
      new Request(`http://svc/settings/tenants/${tenantId}`, {
        method: 'PUT',
        body: JSON.stringify({ key: 'not.a.key', days: 1 }),
      }),
    );
    expect(rejectsUnknownKey.status).toBe(400);
  });

  it('answers 503, not 400 with the raw message, when the write fails for a reason other than validation', async () => {
    const storageFailure = new Error('connection terminated unexpectedly');
    const reporting: Pick<Reporting, 'settings' | 'tenantSettings'> = {
      settings: {
        get: async () => ({ 'events.retention_days': 30 }),
        set: async () => {
          throw storageFailure;
        },
      },
      tenantSettings: {
        get: async () => ({}),
        set: async () => {
          throw storageFailure;
        },
      },
    };
    const handler = createSettingsHandler({
      reporting,
      principal: principalWith('reporting:settings'),
    });

    const siteWide = await handler(
      new Request('http://svc/settings', {
        method: 'PUT',
        body: JSON.stringify({ 'events.retention_days': 14 }),
      }),
    );
    expect(siteWide.status).toBe(503);
    const siteWideBody = (await siteWide.json()) as { error: { message: string } };
    expect(siteWideBody.error.message).not.toContain('connection terminated unexpectedly');

    const tenantId = '11111111-1111-1111-1111-111111111111';
    const tenant = await handler(
      new Request(`http://svc/settings/tenants/${tenantId}`, {
        method: 'PUT',
        body: JSON.stringify({ key: 'events.retention_days', days: 90 }),
      }),
    );
    expect(tenant.status).toBe(503);
    const tenantBody = (await tenant.json()) as { error: { message: string } };
    expect(tenantBody.error.message).not.toContain('connection terminated unexpectedly');
  });
});
