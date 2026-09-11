import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createReporting } from '../index.js';
import { type TestDb, memoryLog, testDb } from '../test/db.js';
import type { Reporting } from '../types.js';
import { type Task, createHousekeeping, pruneEvents, retentionLag } from './index.js';

/**
 * The claim protocol against a real engine. Time is the database's, so the
 * lease and due cases are set up by editing the row rather than by faking a
 * clock. The two-connection race is real-Postgres only.
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
  await t.exec('delete from reporting_tasks; delete from reporting_events;');
});

function task(name: string, run: Task['run'], over: Partial<Task> = {}): Task {
  return { name, every: 3600_000, lease: 60_000, retry: 600_000, run, ...over };
}

async function row(name: string) {
  const [r] = await t.query(
    `select task, last_outcome, last_error, claim_token::text, lease_expires_at, next_due_at > now() as due_later from reporting_tasks where task = '${name}'`,
  );
  return r;
}

describe('the claim protocol', () => {
  it('creates the row, runs a due task once, and schedules the next run', async () => {
    let runs = 0;
    const hk = createHousekeeping({ reporting, debounceMs: 0 });
    hk.register(
      task('t.one', async () => {
        runs += 1;
      }),
    );
    expect(await hk.runNow('t.one')).toBe('ran');
    expect(runs).toBe(1);
    const r = await row('t.one');
    expect(r).toMatchObject({ last_outcome: 'ok', last_error: null, lease_expires_at: null });
    expect(r?.due_later).toBe(true);
    // Not due again: skipped, and the task did not run.
    expect(await hk.runNow('t.one')).toBe('skipped');
    expect(runs).toBe(1);
    const events = await t.query('select kind from reporting_events order by id');
    expect(events.map((e) => e.kind)).toEqual(['housekeeping.task_ran']);
  });

  it('a live lease is not taken over; an expired one is', async () => {
    let runs = 0;
    const hk = createHousekeeping({ reporting, debounceMs: 0 });
    hk.register(
      task('t.lease', async () => {
        runs += 1;
      }),
    );
    await t.exec(`insert into reporting_tasks (task) values ('t.lease') on conflict do nothing`);
    // Somebody else holds it for another minute.
    await t.exec(
      `update reporting_tasks set claim_token = gen_random_uuid(), lease_expires_at = now() + interval '1 minute' where task = 't.lease'`,
    );
    expect(await hk.runNow('t.lease')).toBe('skipped');
    expect(runs).toBe(0);
    // Their lease expired: a crashed container's claim is retaken.
    await t.exec(
      `update reporting_tasks set lease_expires_at = now() - interval '1 second' where task = 't.lease'`,
    );
    expect(await hk.runNow('t.lease')).toBe('ran');
    expect(runs).toBe(1);
  });

  it('a superseded token cannot renew or complete', async () => {
    const hk = createHousekeeping({ reporting, debounceMs: 0 });
    let sawRenew: boolean | null = null;
    hk.register(
      task('t.fence', async (ctx) => {
        // Another container takes over mid-run: its claim replaces ours.
        await t.exec(
          `update reporting_tasks set claim_token = gen_random_uuid(), lease_expires_at = now() + interval '1 minute' where task = 't.fence'`,
        );
        sawRenew = await ctx.renew();
      }),
    );
    expect(await hk.runNow('t.fence')).toBe('ran');
    expect(sawRenew).toBe(false);
    // Our completion touched zero rows: the newer claim's lease still stands.
    const r = await row('t.fence');
    expect(r?.last_outcome).toBeNull();
    expect(r?.lease_expires_at).not.toBeNull();
  });

  it('a failing task records the error, retries later, and writes an error event', async () => {
    const hk = createHousekeeping({ reporting, debounceMs: 0 });
    hk.register(
      task('t.bad', async () => {
        throw new Error('boom');
      }),
    );
    expect(await hk.runNow('t.bad')).toBe('failed');
    const r = await row('t.bad');
    expect(r).toMatchObject({ last_outcome: 'error', last_error: 'Error: boom' });
    const events = await t.query(
      `select kind, level, data from reporting_events where kind = 'housekeeping.task_failed'`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe('error');
  });

  it('a task that overruns its lease is failed by the timeout', async () => {
    const hk = createHousekeeping({ reporting, debounceMs: 0 });
    hk.register(
      task('t.slow', () => new Promise((resolve) => setTimeout(resolve, 500)), { lease: 50 }),
    );
    expect(await hk.runNow('t.slow')).toBe('failed');
    const r = await row('t.slow');
    expect(r?.last_error).toMatch(/timed out/);
  });

  it('tick() debounces per process and writes a tick row only when it claimed something', async () => {
    let runs = 0;
    const hk = createHousekeeping({ reporting, debounceMs: 60_000 });
    hk.register(
      task('t.tick', async () => {
        runs += 1;
      }),
    );
    await hk.tick();
    await hk.tick();
    expect(runs).toBe(1);
    const events = await t.query('select kind from reporting_events order by id');
    expect(events.map((e) => e.kind)).toEqual(['housekeeping.task_ran', 'housekeeping.tick']);
  });

  it('refuses a task name outside the pattern', () => {
    const hk = createHousekeeping({ reporting });
    expect(() => hk.register(task('nodot', async () => {}))).toThrow();
  });
});

describe('the built-in tasks', () => {
  it('prune_events deletes by the operator setting and says how many', async () => {
    const hk = createHousekeeping({ reporting, debounceMs: 0 });
    hk.register(pruneEvents);
    await t.exec(
      `insert into reporting_events (level, kind, site, message, occurred_at) values
        ('info', 'x.old', 'test', 'a', now() - interval '40 days'),
        ('info', 'x.new', 'test', 'b', now() - interval '1 day')`,
    );
    expect(await hk.runNow('reporting.prune_events')).toBe('ran');
    const left = await t.query(`select kind from reporting_events where kind like 'x.%'`);
    expect(left.map((r) => r.kind)).toEqual(['x.new']);
    const pruned = await t.query(
      `select data from reporting_events where kind = 'reporting.pruned'`,
    );
    expect(pruned[0]?.data).toMatchObject({ rows: 1, days: 30 });
  });

  it('retention_lag alerts when the oldest row is older than 1.5 windows, and not otherwise', async () => {
    const hk = createHousekeeping({ reporting, debounceMs: 0 });
    hk.register(retentionLag);
    await t.exec(
      `insert into reporting_events (level, kind, site, message, occurred_at) values ('info', 'x.y', 'test', 'a', now() - interval '20 days')`,
    );
    expect(await hk.runNow('reporting.retention_lag')).toBe('ran');
    let alerts = await t.query(
      `select kind from reporting_events where kind = 'alert.retention_lag'`,
    );
    expect(alerts).toHaveLength(0);
    await t.exec(
      `update reporting_events set occurred_at = now() - interval '50 days' where kind = 'x.y'`,
    );
    await t.exec(
      `update reporting_tasks set next_due_at = now() where task = 'reporting.retention_lag'`,
    );
    expect(await hk.runNow('reporting.retention_lag')).toBe('ran');
    alerts = await t.query(`select data from reporting_events where kind = 'alert.retention_lag'`);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.data).toMatchObject({ check: 'retention_lag', windowDays: 30 });
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('on a real Postgres', () => {
  it('two containers claiming at once yield one runner', async () => {
    // Two independent reporting instances over two connection pools, the
    // way two containers are, racing for one due task.
    const other = await testDbWithoutReset();
    try {
      let runs = 0;
      const slow = (name: string) =>
        task(name, async () => {
          runs += 1;
          await new Promise((resolve) => setTimeout(resolve, 300));
        });
      const a = createHousekeeping({ reporting, debounceMs: 0 });
      const b = createHousekeeping({
        reporting: createReporting({
          db: other.db,
          log: memoryLog(),
          site: 'test',
          mode: 'test',
          defer: () => {},
        }),
        debounceMs: 0,
      });
      a.register(slow('t.race'));
      b.register(slow('t.race'));
      const outcomes = await Promise.all([a.runNow('t.race'), b.runNow('t.race')]);
      expect(outcomes.sort()).toEqual(['ran', 'skipped']);
      expect(runs).toBe(1);
    } finally {
      await other.close();
    }
  });
});

/** A second pool on the same real database, without dropping the schema again. */
async function testDbWithoutReset(): Promise<TestDb> {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const postgres = (await import('postgres')).default;
  const url = process.env.TEST_DATABASE_URL as string;
  const client = postgres(url, { prepare: false, max: 4 });
  return {
    db: drizzle(client) as unknown as TestDb['db'],
    exec: (text) => client.unsafe(text).then(() => undefined),
    query: async (text) => [...(await client.unsafe(text))] as Record<string, unknown>[],
    close: () => client.end(),
    real: true,
  };
}
