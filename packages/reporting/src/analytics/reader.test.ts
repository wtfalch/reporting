import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reportingAnalytics } from '../tables.js';
import type { TestDb } from '../test/db.js';
import { testDb } from '../test/db.js';
import { analyticsRecent } from './reader.js';

/**
 * `analyticsRecent`'s `sessionId` filter (gap issue #9): "everything one
 * session did," the lightest privacy-consistent equivalent of session
 * replay, against a real engine.
 */

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.exec('delete from reporting_analytics');
});

async function seed(over: {
  at: string;
  sessionId?: string | null;
  site?: string;
  name?: string;
}) {
  await t.db.insert(reportingAnalytics).values({
    occurredAt: new Date(over.at),
    receivedAt: new Date(over.at),
    site: over.site ?? 'app',
    sessionId: over.sessionId ?? null,
    name: over.name ?? 'page.view',
    path: '/',
    device: 'desktop',
  });
}

describe('analyticsRecent', () => {
  it('filters to one session, newest first, leaving other sessions out', async () => {
    await seed({ at: '2026-01-01T00:00:00Z', sessionId: 'session-one-aaaa', name: 'page.view' });
    await seed({ at: '2026-01-01T00:01:00Z', sessionId: 'session-one-aaaa', name: 'cta.click' });
    await seed({ at: '2026-01-01T00:02:00Z', sessionId: 'session-two-bbbb', name: 'page.view' });

    const rows = await analyticsRecent(t.db, { site: 'app', sessionId: 'session-one-aaaa' });
    expect(rows.map((r) => r.name)).toEqual(['cta.click', 'page.view']);
  });

  it('returns nothing for an unknown session, rather than every row', async () => {
    await seed({ at: '2026-01-01T00:00:00Z', sessionId: 'session-one-aaaa' });
    const rows = await analyticsRecent(t.db, { site: 'app', sessionId: 'session-unknown-zzzz' });
    expect(rows).toHaveLength(0);
  });

  it('composes with the site filter: a session id from another site is not returned', async () => {
    await seed({ at: '2026-01-01T00:00:00Z', sessionId: 'session-one-aaaa', site: 'other' });
    const rows = await analyticsRecent(t.db, { site: 'app', sessionId: 'session-one-aaaa' });
    expect(rows).toHaveLength(0);
  });

  it('is unfiltered by session when sessionId is omitted', async () => {
    await seed({ at: '2026-01-01T00:00:00Z', sessionId: 'session-one-aaaa' });
    await seed({ at: '2026-01-01T00:01:00Z', sessionId: 'session-two-bbbb' });
    await seed({ at: '2026-01-01T00:02:00Z', sessionId: null });
    const rows = await analyticsRecent(t.db, { site: 'app' });
    expect(rows).toHaveLength(3);
  });
});
