import type { Db } from '@wtfalch/reporting-core';
import { createReporting } from '@wtfalch/reporting-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createErrorsHandler } from './errors.js';
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

describe('createErrorsHandler', () => {
  it('refuses an ingest with no principal', async () => {
    const reporting = createReporting({ db: t.db, log: memoryLog(), site: 'test', mode: 'test' });
    const handler = createErrorsHandler({ db: t.db, reporting, principal: null });
    const response = await handler(
      new Request('http://svc/errors', {
        method: 'POST',
        body: JSON.stringify({ message: 'boom' }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it('refuses a read without reporting:read', async () => {
    const reporting = createReporting({ db: t.db, log: memoryLog(), site: 'test', mode: 'test' });
    const handler = createErrorsHandler({
      db: t.db,
      reporting,
      principal: principalWith('reporting:ingest'),
    });
    const response = await handler(new Request('http://svc/errors', { method: 'GET' }));
    expect(response.status).toBe(403);
  });

  it('refuses resolving a group without reporting:resolve', async () => {
    const reporting = createReporting({ db: t.db, log: memoryLog(), site: 'test', mode: 'test' });
    const handler = createErrorsHandler({
      db: t.db,
      reporting,
      principal: principalWith('reporting:read'),
    });
    const response = await handler(
      new Request(`http://svc/errors/${'a'.repeat(32)}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: 'resolved' }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it('ingests a captured error and reads the group back', async () => {
    const reporting = createReporting({ db: t.db, log: memoryLog(), site: 'test', mode: 'test' });
    const handler = createErrorsHandler({
      db: t.db,
      reporting,
      principal: principalWith('reporting:ingest', 'reporting:read', 'reporting:resolve'),
    });
    const post = await handler(
      new Request('http://svc/errors', {
        method: 'POST',
        body: JSON.stringify({ kind: 'TypeError', message: 'cannot read x of undefined' }),
      }),
    );
    expect(post.status).toBe(202);
    // The group upsert runs through `defer`, which the test's `createReporting`
    // schedules with `setTimeout(0)`; flushing the writer does not wait for
    // it, so this gives the deferred upsert a turn before reading it back.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const list = await handler(new Request('http://svc/errors', { method: 'GET' }));
    expect(list.status).toBe(200);
    const page = (await list.json()) as { items: { fingerprint: string; kind: string }[] };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.kind).toBe('TypeError');

    const fingerprint = page.items[0]?.fingerprint as string;
    const detail = await handler(
      new Request(`http://svc/errors/${fingerprint}`, { method: 'GET' }),
    );
    expect(detail.status).toBe(200);

    const patch = await handler(
      new Request(`http://svc/errors/${fingerprint}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: 'resolved' }),
      }),
    );
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { error: { state: string } };
    expect(patched.error.state).toBe('resolved');
  });

  it('redacts a secret in the posted message and stack before it is stored', async () => {
    const reporting = createReporting({ db: t.db, log: memoryLog(), site: 'test', mode: 'test' });
    const handler = createErrorsHandler({
      db: t.db,
      reporting,
      principal: principalWith('reporting:ingest', 'reporting:read'),
    });
    const secretMessage = 'failed talking to api: api_key=sk_live_abcdef1234567890';
    const secretStack =
      'Error: x\n    at authorize (/app/auth.js:1:1) token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

    const post = await handler(
      new Request('http://svc/errors', {
        method: 'POST',
        body: JSON.stringify({ kind: 'AuthError', message: secretMessage, stack: secretStack }),
      }),
    );
    expect(post.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const list = await handler(new Request('http://svc/errors', { method: 'GET' }));
    const page = (await list.json()) as { items: { message: string; stack: string | null }[] };
    expect(page.items).toHaveLength(1);
    const stored = page.items[0];
    expect(stored?.message).not.toContain('sk_live_abcdef1234567890');
    expect(stored?.message).toContain('[redacted: secret]');
    expect(stored?.stack).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(stored?.stack).toMatch(/\[redacted: (token|secret)\]/);
  });

  it('a write the database cannot store still answers 202, not an error', async () => {
    const brokenDb = {
      transaction: async () => {
        throw new Error('database is down');
      },
    } as unknown as Db;
    const brokenReporting = createReporting({
      db: brokenDb,
      log: memoryLog(),
      site: 'test',
      mode: 'test',
      defer: (fn) => void fn(),
    });
    const handler = createErrorsHandler({
      db: t.db,
      reporting: brokenReporting,
      principal: principalWith('reporting:ingest'),
    });
    const response = await handler(
      new Request('http://svc/errors', {
        method: 'POST',
        body: JSON.stringify({ message: 'boom' }),
      }),
    );
    expect(response.status).toBe(202);
  });
});
