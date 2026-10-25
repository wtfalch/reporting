import type { Db } from '@wtfalch/reporting-core';
import { createReporting } from '@wtfalch/reporting-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventsHandler } from './events.js';
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

describe('createEventsHandler', () => {
  it('refuses a POST with no principal', async () => {
    const log = memoryLog();
    const reporting = createReporting({ db: t.db, log, site: 'test', mode: 'test' });
    const handler = createEventsHandler({ reporting, principal: null });
    const response = await handler(
      new Request('http://svc/events', {
        method: 'POST',
        body: JSON.stringify({ kind: 'forum.drained', message: 'ok' }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it('refuses a POST without the ingest permission', async () => {
    const log = memoryLog();
    const reporting = createReporting({ db: t.db, log, site: 'test', mode: 'test' });
    const handler = createEventsHandler({ reporting, principal: principalWith('reporting:read') });
    const response = await handler(
      new Request('http://svc/events', {
        method: 'POST',
        body: JSON.stringify({ kind: 'forum.drained', message: 'ok' }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it('accepts a valid event and reads it back', async () => {
    const log = memoryLog();
    const reporting = createReporting({ db: t.db, log, site: 'test', mode: 'test' });
    const handler = createEventsHandler({
      reporting,
      principal: principalWith('reporting:ingest', 'reporting:read'),
    });
    const post = await handler(
      new Request('http://svc/events', {
        method: 'POST',
        body: JSON.stringify({ kind: 'forum.drained', message: 'ok', data: { n: 1 } }),
      }),
    );
    expect(post.status).toBe(202);
    await reporting.flush();

    const get = await handler(new Request('http://svc/events', { method: 'GET' }));
    expect(get.status).toBe(200);
    const page = (await get.json()) as { items: { kind: string }[] };
    expect(page.items[0]?.kind).toBe('forum.drained');
  });

  it('refuses a malformed body with invalid_request, not 202', async () => {
    const log = memoryLog();
    const reporting = createReporting({ db: t.db, log, site: 'test', mode: 'test' });
    const handler = createEventsHandler({
      reporting,
      principal: principalWith('reporting:ingest'),
    });
    const response = await handler(
      new Request('http://svc/events', {
        method: 'POST',
        body: JSON.stringify({ message: 'no kind' }),
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  it('a write the database cannot store still answers 202, not an error', async () => {
    const log = memoryLog();
    const brokenDb = {
      insert: () => ({
        values: async () => {
          throw new Error('database is down');
        },
      }),
    } as unknown as Db;
    const reporting = createReporting({ db: brokenDb, log, site: 'test', mode: 'test' });
    const handler = createEventsHandler({
      reporting,
      principal: principalWith('reporting:ingest'),
    });
    const response = await handler(
      new Request('http://svc/events', {
        method: 'POST',
        body: JSON.stringify({ kind: 'forum.drained', message: 'ok' }),
      }),
    );
    expect(response.status).toBe(202);
    // The attempt is made and swallowed, never thrown back to the caller.
    await expect(reporting.flush()).resolves.toBeUndefined();
  });
});
