import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReporting } from '../index.js';
import { KIND_PATTERN } from '../schema.js';
import { reportingEvents } from '../tables.js';
import { type TestDb, memoryLog, testDb } from '../test/db.js';
import type { Db } from '../types.js';

/**
 * `captureError` against a real table (PGlite by default, TEST_DATABASE_URL
 * for a real Postgres): the row shapes, the upsert-on-repeat behaviour, the
 * redaction and the "never throws" contract that a fake database alone
 * cannot prove.
 */

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t.close();
});

/**
 * A stand-in for the host's `after()`: collects every deferred callback's
 * promise so a test can wait for both the writer's flush and the error
 * group's upsert — the two things one `captureError` call schedules —
 * before reading the tables back.
 */
function deferHarness() {
  const pending: Promise<void>[] = [];
  return {
    defer(fn: () => Promise<void>): void {
      pending.push(fn());
    },
    async drain(): Promise<void> {
      const batch = pending.splice(0, pending.length);
      await Promise.all(batch);
    },
  };
}

async function reset() {
  await t.exec('delete from reporting_events');
  await t.exec('delete from reporting_errors');
}

describe('captureError() against the table', () => {
  it('writes one reporting_events row and one reporting_errors row', async () => {
    await reset();
    const h = deferHarness();
    const r = createReporting({
      db: t.db,
      log: memoryLog(),
      site: 'test',
      mode: 'test',
      defer: h.defer,
    });
    r.captureError(new TypeError('boom'));
    await h.drain();
    const events = await t.query('select kind, kind_ns, level, message from reporting_events');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind_ns: 'error', level: 'error', message: 'boom' });
    expect(events[0]?.kind).toBe('error.type_error');
    const errors = await t.query('select kind, message, occurrences, state from reporting_errors');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: 'TypeError', message: 'boom', state: 'open' });
    expect(Number(errors[0]?.occurrences)).toBe(1);
  });

  it('the same error captured three times leaves occurrences = 3, one group row, first_seen_at unchanged and last_seen_at moved', async () => {
    await reset();
    const times = [
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-01-01T00:01:00Z'),
      new Date('2026-01-01T00:02:00Z'),
    ];
    let i = 0;
    const h = deferHarness();
    const r = createReporting({
      db: t.db,
      log: memoryLog(),
      site: 'test',
      mode: 'test',
      defer: h.defer,
      now: () => times[i] as Date,
    });
    for (i = 0; i < 3; i += 1) {
      r.captureError(new TypeError('flaky connection'));
      await h.drain();
    }
    const rows = await t.query(
      'select occurrences, first_seen_at, last_seen_at from reporting_errors',
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.occurrences)).toBe(3);
    expect(new Date(rows[0]?.first_seen_at as string).toISOString()).toBe(times[0]?.toISOString());
    expect(new Date(rows[0]?.last_seen_at as string).toISOString()).toBe(times[2]?.toISOString());
  });

  it('two concurrent occurrences of the same error, upserted before either settles, still land as one row with occurrences = 2', async () => {
    await reset();
    const h = deferHarness();
    const r = createReporting({
      db: t.db,
      log: memoryLog(),
      site: 'test',
      mode: 'test',
      defer: h.defer,
    });
    const err = new TypeError('race');
    // Neither call drains before the next fires: both upserts are in flight
    // against the same fingerprint at once, exercising the database's own
    // conflict serialisation rather than this package's sequencing.
    r.captureError(err);
    r.captureError(err);
    await h.drain();
    const rows = await t.query('select occurrences from reporting_errors');
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.occurrences)).toBe(2);
  });

  it('two different errors make two groups', async () => {
    await reset();
    const h = deferHarness();
    const r = createReporting({
      db: t.db,
      log: memoryLog(),
      site: 'test',
      mode: 'test',
      defer: h.defer,
    });
    r.captureError(new TypeError('a'));
    r.captureError(new RangeError('b'));
    await h.drain();
    const rows = await t.query('select kind from reporting_errors order by kind');
    expect(rows.map((row) => row.kind)).toEqual(['RangeError', 'TypeError']);
  });

  it('redacts a wrapping key out of the stored stack, checked on the stored row, not the input', async () => {
    await reset();
    const originalKek = process.env.KEYSTORE_KEK;
    process.env.KEYSTORE_KEK = `k1:${Buffer.from('a-very-long-wrapping-key-material-value').toString('base64')}`;
    try {
      const h = deferHarness();
      const r = createReporting({
        db: t.db,
        log: memoryLog(),
        site: 'test',
        mode: 'test',
        defer: h.defer,
      });
      const err = new Error('could not unwrap key');
      err.stack = [
        'Error: could not unwrap key',
        '    at unwrap (/app/src/keystore/unwrap.ts:42:11)',
        `    context: KEYSTORE_KEK=${process.env.KEYSTORE_KEK}`,
      ].join('\n');
      r.captureError(err);
      await h.drain();
      const rows = await t.query('select stack from reporting_errors');
      const stack = rows[0]?.stack as string;
      expect(stack).toBeTruthy();
      expect(stack).not.toContain(process.env.KEYSTORE_KEK);
      expect(stack).toContain('[redacted: wrapping key]');
      expect(stack).toContain('at unwrap (/app/src/keystore/unwrap.ts:42:11)');
    } finally {
      // Node coerces an assigned `undefined` to the STRING "undefined", which
      // heldSecrets would then treat as a secret spec and leak into every
      // later test here. Removing the key is the only way to restore the
      // original absence.
      // biome-ignore lint/performance/noDelete: see above
      if (originalKek === undefined) delete process.env.KEYSTORE_KEK;
      else process.env.KEYSTORE_KEK = originalKek;
    }
  });

  it('reopens a resolved group on a new occurrence, clearing resolved_at and resolved_by together', async () => {
    await reset();
    const h = deferHarness();
    const r = createReporting({
      db: t.db,
      log: memoryLog(),
      site: 'test',
      mode: 'test',
      defer: h.defer,
    });
    const err = new TypeError('flaky');
    r.captureError(err);
    await h.drain();
    const [before] = await t.query('select fingerprint from reporting_errors');
    const fp = before?.fingerprint as string;
    await t.exec(
      `update reporting_errors set state = 'resolved', resolved_at = now(), resolved_by = 'op1' where fingerprint = '${fp}'`,
    );
    r.captureError(err);
    await h.drain();
    const [after] = await t.query(
      `select state, resolved_at, resolved_by, occurrences from reporting_errors where fingerprint = '${fp}'`,
    );
    expect(after?.state).toBe('open');
    expect(after?.resolved_at).toBeNull();
    expect(after?.resolved_by).toBeNull();
    expect(Number(after?.occurrences)).toBe(2);
  });

  it('captures a non-Error throw — a string and null — without throwing', async () => {
    await reset();
    const h = deferHarness();
    const r = createReporting({
      db: t.db,
      log: memoryLog(),
      site: 'test',
      mode: 'test',
      defer: h.defer,
    });
    expect(() => r.captureError('a plain string throw')).not.toThrow();
    expect(() => r.captureError(null)).not.toThrow();
    await h.drain();
    const rows = await t.query('select kind from reporting_errors order by kind');
    expect(rows.map((row) => row.kind)).toEqual(['null', 'string']);
  });

  it('truncates an oversized stack from the end and still satisfies the table CHECK', async () => {
    await reset();
    const h = deferHarness();
    const r = createReporting({
      db: t.db,
      log: memoryLog(),
      site: 'test',
      mode: 'test',
      defer: h.defer,
    });
    const err = new Error('huge stack');
    const frames = Array.from(
      { length: 900 },
      (_, i) => `    at frame${i} (/app/src/deep/chain.ts:${i}:1)`,
    );
    err.stack = `Error: huge stack\n${frames.join('\n')}`;
    expect(err.stack.length).toBeGreaterThan(30000);
    r.captureError(err);
    await h.drain();
    const rows = await t.query('select stack from reporting_errors');
    expect(rows).toHaveLength(1);
    const stack = rows[0]?.stack as string;
    expect(stack.length).toBeLessThanOrEqual(16384);
    expect(stack.startsWith('Error: huge stack')).toBe(true);
  });

  it('falls back to error.unknown in the event kind when a class name cannot become a valid kind', async () => {
    await reset();
    class Awkward extends Error {}
    Object.defineProperty(Awkward, 'name', { value: '404 Not-A-Class!!' });
    const h = deferHarness();
    const r = createReporting({
      db: t.db,
      log: memoryLog(),
      site: 'test',
      mode: 'test',
      defer: h.defer,
    });
    r.captureError(new Awkward('nope'));
    await h.drain();
    const rows = await t.query('select kind from reporting_events');
    expect(rows[0]?.kind).toMatch(KIND_PATTERN);
    expect(rows[0]?.kind).toBe('error.unknown');
  });
});

describe('captureError() against a failing database', () => {
  it('does not throw to the caller and reaches the logger', async () => {
    const log = memoryLog();
    const db = {
      insert: (table: unknown) => {
        if (table === reportingEvents) {
          return { values: async () => undefined };
        }
        return {
          values: () => ({
            onConflictDoUpdate: async () => {
              throw new Error('connection refused');
            },
          }),
        };
      },
    } as unknown as Db;
    const h = deferHarness();
    const r = createReporting({ db, log, site: 'test', mode: 'test', defer: h.defer });
    expect(() => r.captureError(new Error('boom'))).not.toThrow();
    await h.drain();
    expect(
      log.lines.some((l) => l.level === 'error' && /error group upsert failed/.test(l.msg ?? '')),
    ).toBe(true);
  });
});
