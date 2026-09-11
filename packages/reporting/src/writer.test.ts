import { describe, expect, it, vi } from 'vitest';
import { createReporting } from './index.js';
import { memoryLog } from './test/db.js';
import type { Db } from './types.js';

/**
 * The writer's failure modes, against a database stand-in that records or
 * refuses inserts. Nothing here reaches Postgres; the row shape and the
 * CHECKs are the integration file's.
 */

function fakeDb(behaviour: { fail?: boolean } = {}) {
  const inserted: unknown[][] = [];
  const db = {
    insert: () => ({
      values: async (rows: unknown[]) => {
        if (behaviour.fail) throw new Error('connection refused');
        inserted.push(rows);
      },
    }),
  } as unknown as Db;
  return { db, inserted };
}

const manual = () => {
  const deferred: Array<() => Promise<void>> = [];
  return { defer: (fn: () => Promise<void>) => void deferred.push(fn), deferred };
};

describe('event()', () => {
  it('logs first, then queues, then flushes in one insert', async () => {
    const log = memoryLog();
    const { db, inserted } = fakeDb();
    const d = manual();
    const r = createReporting({ db, log, site: 'test', defer: d.defer, mode: 'test' });
    r.event({ kind: 'a.b', message: 'one' });
    r.event({ kind: 'a.c', message: 'two', level: 'warn', data: { n: 1 } });
    expect(log.lines.map((l) => l.msg)).toEqual(['one', 'two']);
    expect(log.lines[1]?.level).toBe('warn');
    expect(r.stats().queued).toBe(2);
    expect(d.deferred).toHaveLength(1);
    await r.flush();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toHaveLength(2);
    expect(r.stats()).toMatchObject({ queued: 0, flushed: 2, dropped: 0 });
  });

  it('throws on an invalid row outside production, so the mistake is found', () => {
    const { db } = fakeDb();
    const r = createReporting({ db, log: memoryLog(), site: 'test', mode: 'development' });
    expect(() => r.event({ kind: 'nodot', message: 'x' })).toThrow(/refused/);
    expect(() => r.event({ kind: 'a.b', message: 'x', data: { email: 'a@b' } })).toThrow(/email/);
  });

  it('in production an invalid row becomes a reporting.invalid row and a logger error, never a throw', async () => {
    const log = memoryLog();
    const { db, inserted } = fakeDb();
    const r = createReporting({ db, log, site: 'test', mode: 'production', defer: () => {} });
    expect(() =>
      r.event({ kind: 'a.b', message: 'x', data: { user: { id: 1 } as never } }),
    ).not.toThrow();
    expect(log.lines[0]?.level).toBe('error');
    expect(r.stats().invalid).toBe(1);
    await r.flush();
    const rows = inserted[0] as Array<{ kind: string; data: Record<string, unknown> }>;
    expect(rows[0]?.kind).toBe('reporting.invalid');
    expect(rows[0]?.data).toEqual({ kind: 'a.b' });
  });

  it('a failed flush keeps the rows queued and never throws', async () => {
    const log = memoryLog();
    const { db } = fakeDb({ fail: true });
    const r = createReporting({ db, log, site: 'test', mode: 'test', defer: () => {} });
    r.event({ kind: 'a.b', message: 'x' });
    await expect(r.flush()).resolves.toBeUndefined();
    expect(r.stats()).toMatchObject({ queued: 1, flushed: 0, failedFlushes: 1 });
    expect(log.lines.at(-1)?.msg).toMatch(/flush failed/);
  });

  it('caps the queue and reports the drop on the next successful flush', async () => {
    const { db, inserted } = fakeDb();
    const r = createReporting({
      db,
      log: memoryLog(),
      site: 'test',
      mode: 'test',
      defer: () => {},
      queueLimit: 3,
      batchSize: 10,
    });
    for (let i = 0; i < 5; i += 1) r.event({ kind: 'a.b', message: `m${i}` });
    expect(r.stats()).toMatchObject({ queued: 3, dropped: 2 });
    await r.flush();
    const rows = inserted[0] as Array<{ kind: string; data: Record<string, unknown> }>;
    expect(rows).toHaveLength(4);
    expect(rows[3]).toMatchObject({ kind: 'reporting.dropped', data: { count: 2 } });
  });

  it('flushes on the timer when nobody calls defer', async () => {
    vi.useFakeTimers();
    try {
      const { db, inserted } = fakeDb();
      const r = createReporting({
        db,
        log: memoryLog(),
        site: 'test',
        mode: 'test',
        defer: () => {},
        flushEveryMs: 50,
      });
      r.event({ kind: 'a.b', message: 'x' });
      expect(inserted).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(60);
      expect(inserted).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a defer that throws does not lose the event', async () => {
    const log = memoryLog();
    const { db, inserted } = fakeDb();
    const r = createReporting({
      db,
      log,
      site: 'test',
      mode: 'test',
      defer: () => {
        throw new Error('outside a request');
      },
    });
    r.event({ kind: 'a.b', message: 'x' });
    expect(log.lines.some((l) => /defer threw/.test(l.msg ?? ''))).toBe(true);
    await r.flush();
    expect(inserted).toHaveLength(1);
  });

  it('stamps the site and the actor, never a bare id', async () => {
    const { db, inserted } = fakeDb();
    const r = createReporting({
      db,
      log: memoryLog(),
      site: 'manage',
      mode: 'test',
      defer: () => {},
    });
    r.event({ kind: 'a.b', message: 'x', actor: { class: 'human', id: 'u1' } });
    await r.flush();
    expect(inserted[0]?.[0]).toMatchObject({ site: 'manage', actorClass: 'human', actorId: 'u1' });
  });
});

describe('flush() with overlapping callers', () => {
  it('returns only when every row is in the table, including rows another flush took off the queue', async () => {
    // A slow insert, so the two flushes overlap the way the timer's and a
    // request's do: the first splices the queue and waits on the database;
    // a second row arrives; the second caller must not return until both
    // inserts have landed.
    const inserted: unknown[][] = [];
    // A holder rather than a `let`, because TypeScript narrows a `let` to its
    // initialiser across the closure and calls the release "not callable".
    const gate: { release?: () => void } = {};
    const db = {
      insert: () => ({
        values: (rows: unknown[]) =>
          new Promise<void>((resolve) => {
            gate.release = () => {
              inserted.push(rows);
              resolve();
            };
          }),
      }),
    } as unknown as Db;
    const r = createReporting({
      db,
      log: memoryLog(),
      site: 'test',
      mode: 'test',
      defer: () => {},
    });
    r.event({ kind: 'a.b', message: 'first' });
    const first = r.flush();
    await Promise.resolve();
    r.event({ kind: 'a.b', message: 'second' });
    let secondDone = false;
    const second = r.flush().then(() => {
      secondDone = true;
    });
    await Promise.resolve();
    expect(secondDone).toBe(false);
    // Land the first insert; the second flush must go on to insert the row
    // the first one did not carry, and only then resolve.
    gate.release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondDone).toBe(false);
    gate.release?.();
    await Promise.all([first, second]);
    expect(inserted.flat()).toHaveLength(2);
    expect(r.stats()).toMatchObject({ queued: 0, flushed: 2 });
  });
});

describe('alert()', () => {
  it('writes an alert row and calls onAlert, swallowing its throw', async () => {
    const log = memoryLog();
    const { db, inserted } = fakeDb();
    const onAlert = vi.fn(() => {
      throw new Error('sentry down');
    });
    const r = createReporting({ db, log, site: 'test', mode: 'test', defer: () => {}, onAlert });
    r.alert({ check: 'orphan_memberships', message: '2 rows', detail: [1, 2] });
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(log.lines.some((l) => /onAlert threw/.test(l.msg ?? ''))).toBe(true);
    await r.flush();
    expect(inserted[0]?.[0]).toMatchObject({
      kind: 'alert.orphan_memberships',
      level: 'alert',
      data: { check: 'orphan_memberships', count: 2 },
    });
  });
});

describe('createReporting', () => {
  it('refuses a site id outside the pattern', () => {
    const { db } = fakeDb();
    expect(() => createReporting({ db, log: memoryLog(), site: 'Bad Site' })).toThrow();
  });
});
