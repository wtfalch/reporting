import { createReporting, reportingRequests } from '@wtfalch/reporting-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Permission, ReportingPrincipal } from './principal.js';
import { createRequestsHandler } from './requests.js';
import { memoryLog, testDb } from './test/db.js';
import type { TestDb } from './test/db.js';

function principalWith(...permissions: Permission[]): ReportingPrincipal {
  return { actor: { class: 'service', id: 'test' }, permissions: new Set(permissions) };
}

let t: TestDb;
beforeEach(async () => {
  t = await testDb();
});
afterEach(async () => {
  await t.close();
});

describe('createRequestsHandler', () => {
  it('refuses a record with no principal', async () => {
    const reporting = createReporting({ db: t.db, log: memoryLog(), site: 'test', mode: 'test' });
    const handler = createRequestsHandler({ reporting, principal: null });
    const response = await handler(
      new Request('http://svc/requests', { method: 'POST', body: JSON.stringify({ status: 200 }) }),
    );
    expect(response.status).toBe(401);
  });

  it('refuses a record without reporting:ingest', async () => {
    const reporting = createReporting({ db: t.db, log: memoryLog(), site: 'test', mode: 'test' });
    const handler = createRequestsHandler({
      reporting,
      principal: principalWith('reporting:read'),
    });
    const response = await handler(
      new Request('http://svc/requests', { method: 'POST', body: JSON.stringify({ status: 200 }) }),
    );
    expect(response.status).toBe(403);
  });

  it('rejects a body with neither status nor error', async () => {
    const reporting = createReporting({ db: t.db, log: memoryLog(), site: 'test', mode: 'test' });
    const handler = createRequestsHandler({
      reporting,
      principal: principalWith('reporting:ingest'),
    });
    const response = await handler(
      new Request('http://svc/requests', { method: 'POST', body: '{}' }),
    );
    expect(response.status).toBe(400);
  });

  it('counts a response by status and duration', async () => {
    const reporting = createReporting({ db: t.db, log: memoryLog(), site: 'test', mode: 'test' });
    const handler = createRequestsHandler({
      reporting,
      principal: principalWith('reporting:ingest'),
    });
    const response = await handler(
      new Request('http://svc/requests', {
        method: 'POST',
        body: JSON.stringify({ status: 500, durationMs: 1200 }),
      }),
    );
    expect(response.status).toBe(202);
    await reporting.flush();
    const rows = await t.db.select().from(reportingRequests);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requests: 1, errors: 1, slow: 1 });
  });

  it('counts a 5xx noticed after the response already went out, for a request already recorded', async () => {
    const reporting = createReporting({ db: t.db, log: memoryLog(), site: 'test', mode: 'test' });
    const handler = createRequestsHandler({
      reporting,
      principal: principalWith('reporting:ingest'),
    });
    const first = await handler(
      new Request('http://svc/requests', { method: 'POST', body: JSON.stringify({ status: 200 }) }),
    );
    expect(first.status).toBe(202);
    const second = await handler(
      new Request('http://svc/requests', { method: 'POST', body: JSON.stringify({ error: true }) }),
    );
    expect(second.status).toBe(202);
    await reporting.flush();
    const rows = await t.db.select().from(reportingRequests);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requests: 1, errors: 1 });
  });
});
