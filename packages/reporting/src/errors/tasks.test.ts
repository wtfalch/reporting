import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHousekeeping } from '../housekeeping/index.js';
import { createReporting } from '../index.js';
import { reportingErrors } from '../tables.js';
import { type TestDb, memoryLog, testDb } from '../test/db.js';
import type { Reporting } from '../types.js';
import { pruneErrors } from './tasks.js';

/**
 * `reporting_prune_errors` (the SQL function, 0003_errors.sql) and the
 * `pruneErrors` task that wraps it. The one behaviour that matters most: an
 * 'open' row is never a candidate, no matter how old — the rest is the same
 * clamp-and-batch shape as `reporting_prune_events` (migration.test.ts).
 */

let t: TestDb;
let reporting: Reporting;
beforeAll(async () => {
  t = await testDb();
  reporting = createReporting({
    db: t.db,
    log: memoryLog(),
    site: 'test',
    mode: 'test',
    defer: () => {},
  });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.exec(
    'delete from reporting_tasks; delete from reporting_events; delete from reporting_errors;',
  );
});

const fp = (n: number) => n.toString(16).padStart(32, '0');
const DAY = 24 * 60 * 60 * 1000;

async function seedError(over: {
  fingerprint: string;
  state: 'open' | 'resolved' | 'ignored';
  daysAgo: number;
}) {
  const when = new Date(Date.now() - over.daysAgo * DAY);
  await t.db.insert(reportingErrors).values({
    fingerprint: over.fingerprint,
    site: 'test',
    kind: 'TypeError',
    message: 'boom',
    runtime: 'server',
    firstSeenAt: when,
    lastSeenAt: when,
    state: over.state,
    resolvedAt: over.state === 'open' ? null : when,
    resolvedBy: over.state === 'open' ? null : 'human:op1',
  });
}

async function errorCount(): Promise<number> {
  const rows = await t.query('select count(*)::int as n from reporting_errors');
  return Number(rows[0]?.n ?? 0);
}

describe('reporting_prune_errors', () => {
  it('deletes a resolved row past the window', async () => {
    await seedError({ fingerprint: fp(1), state: 'resolved', daysAgo: 40 });
    const [n] = await t.query(`select reporting_prune_errors(interval '30 days', 5000) as n`);
    expect(Number(n?.n)).toBe(1);
    expect(await errorCount()).toBe(0);
  });

  it('never deletes an open row, no matter how old', async () => {
    await seedError({ fingerprint: fp(2), state: 'open', daysAgo: 400 });
    const [n] = await t.query(`select reporting_prune_errors(interval '30 days', 5000) as n`);
    expect(Number(n?.n)).toBe(0);
    expect(await errorCount()).toBe(1);
  });

  it('does not delete a resolved row inside the window', async () => {
    await seedError({ fingerprint: fp(3), state: 'resolved', daysAgo: 1 });
    const [n] = await t.query(`select reporting_prune_errors(interval '30 days', 5000) as n`);
    expect(Number(n?.n)).toBe(0);
    expect(await errorCount()).toBe(1);
  });

  it('an ignored row past the window is eligible too', async () => {
    await seedError({ fingerprint: fp(4), state: 'ignored', daysAgo: 40 });
    const [n] = await t.query(`select reporting_prune_errors(interval '30 days', 5000) as n`);
    expect(Number(n?.n)).toBe(1);
  });

  it('a mix: only the resolved-and-old row goes, the open-and-old and resolved-and-recent rows stay', async () => {
    await seedError({ fingerprint: fp(5), state: 'resolved', daysAgo: 40 });
    await seedError({ fingerprint: fp(6), state: 'open', daysAgo: 40 });
    await seedError({ fingerprint: fp(7), state: 'resolved', daysAgo: 1 });
    const [n] = await t.query(`select reporting_prune_errors(interval '30 days', 5000) as n`);
    expect(Number(n?.n)).toBe(1);
    const left = await t.query('select fingerprint from reporting_errors order by fingerprint');
    expect(left.map((r) => r.fingerprint).sort()).toEqual([fp(6), fp(7)].sort());
  });

  it('clamps the window to seven days at the floor', async () => {
    await seedError({ fingerprint: fp(8), state: 'resolved', daysAgo: 3 });
    await seedError({ fingerprint: fp(9), state: 'resolved', daysAgo: 10 });
    const [n] = await t.query(`select reporting_prune_errors(interval '1 day', 5000) as n`);
    expect(Number(n?.n)).toBe(1);
    expect(await errorCount()).toBe(1);
  });

  it('clamps the window to four hundred days at the ceiling', async () => {
    await seedError({ fingerprint: fp(10), state: 'resolved', daysAgo: 401 });
    const [n] = await t.query(`select reporting_prune_errors(interval '1000 days', 5000) as n`);
    expect(Number(n?.n)).toBe(1);
  });

  it('clamps the batch and treats nulls as the defaults', async () => {
    for (let i = 0; i < 7; i += 1) {
      await seedError({ fingerprint: fp(20 + i), state: 'resolved', daysAgo: 400 });
    }
    const [first] = await t.query(`select reporting_prune_errors(interval '30 days', 3) as n`);
    expect(Number(first?.n)).toBe(3);
    const [zero] = await t.query(`select reporting_prune_errors(interval '30 days', 0) as n`);
    expect(Number(zero?.n)).toBe(1);
    const [nulls] = await t.query('select reporting_prune_errors(null, null) as n');
    expect(Number(nulls?.n)).toBe(3);
    expect(await errorCount()).toBe(0);
  });
});

describe('pruneErrors task', () => {
  it('reuses events.retention_days, deletes eligible rows and writes an event only when something was pruned', async () => {
    const hk = createHousekeeping({ reporting, db: t.db, debounceMs: 0 });
    hk.register(pruneErrors);
    await seedError({ fingerprint: fp(30), state: 'resolved', daysAgo: 40 });
    await seedError({ fingerprint: fp(31), state: 'open', daysAgo: 40 });
    expect(await hk.runNow('reporting.prune_errors')).toBe('ran');
    const left = await t.query('select fingerprint from reporting_errors');
    expect(left.map((r) => r.fingerprint)).toEqual([fp(31)]);
    const pruned = await t.query(
      `select data from reporting_events where kind = 'reporting.pruned_errors'`,
    );
    expect(pruned).toHaveLength(1);
    expect(pruned[0]?.data).toMatchObject({ rows: 1, days: 30 });
  });

  it('writes no event when nothing was eligible', async () => {
    const hk = createHousekeeping({ reporting, db: t.db, debounceMs: 0 });
    hk.register(pruneErrors);
    await seedError({ fingerprint: fp(40), state: 'open', daysAgo: 400 });
    expect(await hk.runNow('reporting.prune_errors')).toBe('ran');
    const pruned = await t.query(
      `select data from reporting_events where kind = 'reporting.pruned_errors'`,
    );
    expect(pruned).toHaveLength(0);
  });
});
