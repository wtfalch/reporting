import { reportingRequests } from '@wtfalch/reporting-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Permission, ReportingPrincipal } from './principal.js';
import { createReleaseHealthHandler } from './release-health.js';
import { memoryLog, testDb } from './test/db.js';
import type { TestDb } from './test/db.js';

function principalWith(...permissions: Permission[]): ReportingPrincipal {
  return { actor: { class: 'service', id: 'foundry' }, permissions: new Set(permissions) };
}

let t: TestDb;
beforeEach(async () => {
  t = await testDb();
});
afterEach(async () => {
  await t.close();
});

describe('createReleaseHealthHandler', () => {
  it('refuses a read with no principal', async () => {
    const handler = createReleaseHealthHandler({
      db: t.db,
      site: 'test',
      log: memoryLog(),
      principal: null,
    });
    const response = await handler(
      new Request('http://svc/release-health?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z'),
    );
    expect(response.status).toBe(401);
  });

  it('refuses a read without reporting:release-health', async () => {
    const handler = createReleaseHealthHandler({
      db: t.db,
      site: 'test',
      log: memoryLog(),
      principal: principalWith('reporting:read'),
    });
    const response = await handler(
      new Request('http://svc/release-health?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z'),
    );
    expect(response.status).toBe(403);
  });

  it('rejects a missing or malformed range', async () => {
    const handler = createReleaseHealthHandler({
      db: t.db,
      site: 'test',
      log: memoryLog(),
      principal: principalWith('reporting:release-health'),
    });
    const noParams = await handler(new Request('http://svc/release-health'));
    expect(noParams.status).toBe(400);
    const backwards = await handler(
      new Request('http://svc/release-health?from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z'),
    );
    expect(backwards.status).toBe(400);
  });

  it('sums requests and errors by color over the range, plus the baseline', async () => {
    await t.db.insert(reportingRequests).values([
      {
        bucket: new Date('2026-01-01T12:00:00Z'),
        site: 'test',
        color: 'blue',
        release: 'r1',
        requests: 100,
        errors: 5,
        durationMsSum: 0,
        slow: 0,
        signIns: 0,
        signInFailures: 0,
      },
      {
        bucket: new Date('2025-12-30T12:00:00Z'),
        site: 'test',
        color: 'blue',
        release: 'r0',
        requests: 70,
        errors: 7,
        durationMsSum: 0,
        slow: 0,
        signIns: 0,
        signInFailures: 0,
      },
    ]);
    const handler = createReleaseHealthHandler({
      db: t.db,
      site: 'test',
      log: memoryLog(),
      principal: principalWith('reporting:release-health'),
    });
    const response = await handler(
      new Request('http://svc/release-health?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z'),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      colors: { blue: { requests: number; errors: number } };
      daily: { requestsPerDay: number };
    };
    expect(body.colors.blue).toEqual({ requests: 100, errors: 5 });
    expect(body.daily.requestsPerDay).toBe(10);
  });
});
