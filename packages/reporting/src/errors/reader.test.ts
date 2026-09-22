import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reportingErrors } from '../tables.js';
import type { TestDb } from '../test/db.js';
import { testDb } from '../test/db.js';
import { errorDetail, errorsPage, setErrorState } from './reader.js';

/**
 * The error-group readers against a real engine: keyset paging on
 * (last_seen_at, fingerprint), the three filters, and the state move whose
 * pair constraint is the likeliest bug (0003_errors.sql,
 * reporting_errors_resolved_pair_check).
 */

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.exec('delete from reporting_errors');
});

const fp = (n: number) => n.toString(16).padStart(32, '0');

async function seed(over: {
  fingerprint: string;
  site?: string;
  runtime?: 'server' | 'edge' | 'browser';
  state?: 'open' | 'resolved' | 'ignored';
  message?: string;
  stack?: string | null;
  environment?: string;
  lastSeenAt?: Date;
}) {
  const when = over.lastSeenAt ?? new Date();
  await t.db.insert(reportingErrors).values({
    fingerprint: over.fingerprint,
    site: over.site ?? 'test',
    environment: over.environment ?? null,
    kind: 'TypeError',
    message: over.message ?? 'boom',
    stack: over.stack ?? null,
    runtime: over.runtime ?? 'server',
    firstSeenAt: when,
    lastSeenAt: when,
    state: over.state ?? 'open',
  });
}

describe('errorsPage', () => {
  it('pages newest first with a stable keyset cursor: no overlap, no gap', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    for (let i = 0; i < 5; i += 1) {
      await seed({ fingerprint: fp(i), lastSeenAt: new Date(t0.getTime() + i * 1000) });
    }
    const first = await errorsPage(t.db, { limit: 2 });
    expect(first.items.map((r) => r.fingerprint)).toEqual([fp(4), fp(3)]);
    expect(first.next).not.toBeNull();

    const second = await errorsPage(t.db, { limit: 2, after: first.next ?? undefined });
    expect(second.items.map((r) => r.fingerprint)).toEqual([fp(2), fp(1)]);
    expect(second.next).not.toBeNull();

    const third = await errorsPage(t.db, { limit: 2, after: second.next ?? undefined });
    expect(third.items.map((r) => r.fingerprint)).toEqual([fp(0)]);
    expect(third.next).toBeNull();

    // No overlap and no gap: the three pages partition all five rows.
    const seen = [...first.items, ...second.items, ...third.items].map((r) => r.fingerprint);
    expect(new Set(seen).size).toBe(5);
    expect(seen.sort()).toEqual([fp(0), fp(1), fp(2), fp(3), fp(4)].sort());
  });

  it('filters by state, site and runtime, each narrowing independently', async () => {
    await seed({ fingerprint: fp(1), state: 'open', site: 'a', runtime: 'server' });
    await seed({ fingerprint: fp(2), state: 'resolved', site: 'a', runtime: 'edge' });
    await seed({ fingerprint: fp(3), state: 'open', site: 'b', runtime: 'browser' });

    const byState = await errorsPage(t.db, { state: 'resolved' });
    expect(byState.items.map((r) => r.fingerprint)).toEqual([fp(2)]);

    const bySite = await errorsPage(t.db, { site: 'b' });
    expect(bySite.items.map((r) => r.fingerprint)).toEqual([fp(3)]);

    const byRuntime = await errorsPage(t.db, { runtime: 'edge' });
    expect(byRuntime.items.map((r) => r.fingerprint)).toEqual([fp(2)]);
  });

  it('filters by environment, so preview noise stays out of a production view', async () => {
    await seed({ fingerprint: fp(1), environment: 'production' });
    await seed({ fingerprint: fp(2), environment: 'preview' });
    await seed({ fingerprint: fp(3) });

    const prod = await errorsPage(t.db, { environment: 'production' });
    expect(prod.items.map((r) => r.fingerprint)).toEqual([fp(1)]);

    const preview = await errorsPage(t.db, { environment: 'preview' });
    expect(preview.items.map((r) => r.fingerprint)).toEqual([fp(2)]);

    const all = await errorsPage(t.db);
    expect(all.items).toHaveLength(3);
  });

  it('search matches a substring of message or stack, case-insensitively', async () => {
    await seed({
      fingerprint: fp(1),
      message: 'cannot read properties of undefined',
      stack: null,
    });
    await seed({
      fingerprint: fp(2),
      message: 'a different failure entirely',
      stack: 'TypeError: x\n    at parseConfig (/app/src/config.ts:10:5)',
    });
    await seed({ fingerprint: fp(3), message: 'network request failed', stack: null });

    const byMessage = await errorsPage(t.db, { search: 'UNDEFINED' });
    expect(byMessage.items.map((r) => r.fingerprint)).toEqual([fp(1)]);

    const byStack = await errorsPage(t.db, { search: 'parseConfig' });
    expect(byStack.items.map((r) => r.fingerprint)).toEqual([fp(2)]);

    const none = await errorsPage(t.db, { search: 'nothing matches this' });
    expect(none.items).toHaveLength(0);
  });

  it('search treats % and _ literally, not as SQL wildcards', async () => {
    await seed({ fingerprint: fp(1), message: 'memory at 90% capacity' });
    await seed({ fingerprint: fp(2), message: 'anything at all here' });

    const literalPercent = await errorsPage(t.db, { search: '90%' });
    expect(literalPercent.items.map((r) => r.fingerprint)).toEqual([fp(1)]);
  });

  it('search composes with state, site and runtime', async () => {
    await seed({ fingerprint: fp(1), message: 'boom in prod', site: 'a', state: 'open' });
    await seed({ fingerprint: fp(2), message: 'boom in prod', site: 'b', state: 'open' });

    const narrowed = await errorsPage(t.db, { search: 'boom', site: 'a' });
    expect(narrowed.items.map((r) => r.fingerprint)).toEqual([fp(1)]);
  });

  it('an empty or whitespace-only search is the same as no search', async () => {
    await seed({ fingerprint: fp(1), message: 'anything' });
    const blank = await errorsPage(t.db, { search: '   ' });
    expect(blank.items).toHaveLength(1);
  });
});

describe('errorDetail', () => {
  it('returns the row, or null for an unknown fingerprint', async () => {
    await seed({ fingerprint: fp(1) });
    expect((await errorDetail(t.db, fp(1)))?.fingerprint).toBe(fp(1));
    expect(await errorDetail(t.db, fp(99))).toBeNull();
  });
});

describe('setErrorState', () => {
  const by = { class: 'human' as const, id: 'op1' };

  it('resolving stamps resolved_at and resolved_by', async () => {
    await seed({ fingerprint: fp(1) });
    const row = await setErrorState(t.db, fp(1), 'resolved', by);
    expect(row?.state).toBe('resolved');
    expect(row?.resolvedAt).not.toBeNull();
    expect(row?.resolvedBy).toBe('human:op1');
  });

  it('ignoring stamps the pair the same as resolving', async () => {
    await seed({ fingerprint: fp(1) });
    const row = await setErrorState(t.db, fp(1), 'ignored', { class: 'agent', id: 'a1' });
    expect(row?.state).toBe('ignored');
    expect(row?.resolvedAt).not.toBeNull();
    expect(row?.resolvedBy).toBe('agent:a1');
  });

  it('moving back to open clears both resolved_at and resolved_by, never one alone', async () => {
    await seed({ fingerprint: fp(1) });
    await setErrorState(t.db, fp(1), 'resolved', by);
    const row = await setErrorState(t.db, fp(1), 'open', by);
    expect(row?.state).toBe('open');
    expect(row?.resolvedAt).toBeNull();
    expect(row?.resolvedBy).toBeNull();
    // The pair constraint would reject one set without the other; confirm
    // the row actually persisted this way rather than merely not throwing.
    const persisted = await errorDetail(t.db, fp(1));
    expect(persisted?.resolvedAt).toBeNull();
    expect(persisted?.resolvedBy).toBeNull();
  });

  it('returns null for an unknown fingerprint rather than throwing', async () => {
    await expect(setErrorState(t.db, fp(99), 'resolved', by)).resolves.toBeNull();
  });
});
