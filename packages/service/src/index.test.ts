import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReportingService } from './index.js';
import type { Permission, ReportingPrincipal } from './principal.js';
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

describe('createReportingService', () => {
  it('wires one Reporting instance shared by every route, and registers the housekeeping tasks', async () => {
    const service = createReportingService({
      db: t.db,
      log: memoryLog(),
      site: 'test',
      mode: 'test',
    });
    expect(service.reporting.site).toBe('test');
    const names = service.housekeeping.tasks().map((task) => task.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'reporting.prune_events',
        'reporting.retention_lag',
        'reporting.prune_open_errors',
        'reporting.prune_errors',
      ]),
    );
  });

  it('builds a working events route from its own factory', async () => {
    const service = createReportingService({
      db: t.db,
      log: memoryLog(),
      site: 'test',
      mode: 'test',
    });
    const handler = service.events(principalWith('reporting:ingest', 'reporting:read'));
    const post = await handler(
      new Request('http://svc/events', {
        method: 'POST',
        body: JSON.stringify({ kind: 'forum.drained', message: 'ok' }),
      }),
    );
    expect(post.status).toBe(202);
    await service.reporting.flush();
    const get = await handler(new Request('http://svc/events'));
    const page = (await get.json()) as { items: unknown[] };
    expect(page.items).toHaveLength(1);
  });

  it('refuses every route with no principal', async () => {
    const service = createReportingService({
      db: t.db,
      log: memoryLog(),
      site: 'test',
      mode: 'test',
    });
    const getRoutes = [
      service.events(null),
      service.errors(null),
      service.settings(null),
      service.releaseHealth(null),
    ];
    for (const handler of getRoutes) {
      const response = await handler(new Request('http://svc/x'));
      expect(response.status).toBe(401);
    }
    const requestsResponse = await service.requests(null)(
      new Request('http://svc/requests', { method: 'POST', body: '{}' }),
    );
    expect(requestsResponse.status).toBe(401);
  });
});
