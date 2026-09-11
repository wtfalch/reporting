import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReporting } from './index.js';
import { reportingEvents } from './tables.js';
import { MIGRATION_SQL, type TestDb, memoryLog, testDb } from './test/db.js';

/**
 * The migration against a real database engine: PGlite in memory by
 * default, a Postgres 16 with TEST_DATABASE_URL. Every CHECK refuses its
 * case, the prune function's clamp and its timestamp eligibility hold, and
 * the writer's rows land as the table expects.
 */

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t.close();
});

const base = 'insert into reporting_events (level, kind, site, message) values';

describe('0001_reporting.sql', () => {
  it('applies twice without complaint', async () => {
    await t.exec(MIGRATION_SQL);
  });

  it('accepts a minimal row and derives kind_ns', async () => {
    await t.exec(`${base} ('info', 'forum.drained', 'test', 'ok')`);
    const rows = await t.query(`select kind_ns from reporting_events where kind = 'forum.drained'`);
    expect(rows[0]?.kind_ns).toBe('forum');
  });

  it.each([
    ['a level outside the four', `${base} ('debug', 'a.b', 'test', 'm')`],
    ['a kind without a dot', `${base} ('info', 'ab', 'test', 'm')`],
    ['a kind with two dots', `${base} ('info', 'a.b.c', 'test', 'm')`],
    ['an upper-case site', `${base} ('info', 'a.b', 'Test', 'm')`],
    ['an empty message', `${base} ('info', 'a.b', 'test', '')`],
    ['a message over 512', `${base} ('info', 'a.b', 'test', repeat('x', 513))`],
    [
      'an actor id without a class',
      `insert into reporting_events (level, kind, site, message, actor_id) values ('info', 'a.b', 'test', 'm', 'u1')`,
    ],
    [
      'a target type without an id',
      `insert into reporting_events (level, kind, site, message, target_type) values ('info', 'a.b', 'test', 'm', 'mailbox')`,
    ],
    [
      'nested data',
      `insert into reporting_events (level, kind, site, message, data) values ('info', 'a.b', 'test', 'm', '{"user": {"id": 1}}')`,
    ],
    [
      'an array in data',
      `insert into reporting_events (level, kind, site, message, data) values ('info', 'a.b', 'test', 'm', '{"ids": [1]}')`,
    ],
    [
      'a banned key',
      `insert into reporting_events (level, kind, site, message, data) values ('info', 'a.b', 'test', 'm', '{"email": "a@b.c"}')`,
    ],
    [
      'data that is not an object',
      `insert into reporting_events (level, kind, site, message, data) values ('info', 'a.b', 'test', 'm', '[1]')`,
    ],
  ])('refuses %s', async (_name, statement) => {
    await expect(t.exec(statement)).rejects.toThrow();
  });

  it('refuses a task name outside the pattern and an outcome outside the three', async () => {
    await expect(t.exec(`insert into reporting_tasks (task) values ('nodot')`)).rejects.toThrow();
    await expect(
      t.exec(`insert into reporting_tasks (task, last_outcome) values ('a.b', 'maybe')`),
    ).rejects.toThrow();
  });

  it('refuses a settings key outside the reserved namespaces', async () => {
    await expect(
      t.exec(`insert into reporting_settings (key, value) values ('audit.x', '1')`),
    ).rejects.toThrow();
    await t.exec(
      `insert into reporting_settings (key, value) values ('analytics.retention_days', '90')`,
    );
  });
});

describe('reporting_prune_events', () => {
  async function seed(daysAgo: number, message: string) {
    await t.exec(`${base} ('info', 'a.b', 'test', '${message}')`.replace('values', 'values'));
    await t.exec(
      `update reporting_events set occurred_at = now() - interval '${daysAgo} days' where message = '${message}'`,
    );
  }

  async function count(): Promise<number> {
    const rows = await t.query(
      `select count(*)::int as n from reporting_events where kind = 'a.b'`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  it('deletes only rows older than the window, by timestamp and not by id', async () => {
    await t.exec('delete from reporting_events');
    // Inserted in this order, so ids ascend: old, new, old. An id boundary
    // would take the middle row; the timestamp rule must not.
    await seed(40, 'old-1');
    await seed(1, 'new');
    await seed(45, 'old-2');
    const [n] = await t.query(`select reporting_prune_events(interval '30 days', 5000) as n`);
    expect(Number(n?.n)).toBe(2);
    const left = await t.query('select message from reporting_events order by id');
    expect(left.map((r) => r.message)).toEqual(['new']);
  });

  it('clamps the window to seven days at the floor', async () => {
    await t.exec('delete from reporting_events');
    await seed(3, 'three');
    await seed(10, 'ten');
    const [n] = await t.query(`select reporting_prune_events(interval '1 day', 5000) as n`);
    expect(Number(n?.n)).toBe(1);
    expect(await count()).toBe(1);
  });

  it('clamps the window to four hundred days at the ceiling', async () => {
    await t.exec('delete from reporting_events');
    await seed(401, 'ancient');
    const [n] = await t.query(`select reporting_prune_events(interval '1000 days', 5000) as n`);
    expect(Number(n?.n)).toBe(1);
  });

  it('clamps the batch and treats nulls as the defaults', async () => {
    await t.exec('delete from reporting_events');
    for (let i = 0; i < 7; i += 1) await seed(400, `b${i}`);
    const [first] = await t.query(`select reporting_prune_events(interval '30 days', 3) as n`);
    expect(Number(first?.n)).toBe(3);
    const [zero] = await t.query(`select reporting_prune_events(interval '30 days', 0) as n`);
    expect(Number(zero?.n)).toBe(1);
    const [nulls] = await t.query('select reporting_prune_events(null, null) as n');
    expect(Number(nulls?.n)).toBe(3);
    expect(await count()).toBe(0);
  });
});

describe('the writer against the table', () => {
  it('lands a full row and reads it back through the reader', async () => {
    await t.exec('delete from reporting_events');
    const r = createReporting({
      db: t.db,
      log: memoryLog(),
      site: 'test',
      mode: 'test',
      defer: () => {},
    });
    r.event({
      kind: 'mail.write_refused',
      level: 'warn',
      message: 'the instance said no',
      tenantId: '11111111-1111-4111-8111-111111111111',
      actor: { class: 'human', id: 'u1' },
      requestId: 'ray-1',
      target: { type: 'mailbox', id: 'ops' },
      data: { type: 'forbidden', attempt: 2, ok: false, note: null },
    });
    await r.flush();
    expect(r.stats().flushed).toBe(1);
    const page = await r.events.page({ requestId: 'ray-1' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      kind: 'mail.write_refused',
      kindNs: 'mail',
      site: 'test',
      actorClass: 'human',
      actorId: 'u1',
      targetType: 'mailbox',
      targetId: 'ops',
      data: { type: 'forbidden', attempt: 2, ok: false, note: null },
    });
  });

  it('pages newest first with a stable keyset cursor across an insert', async () => {
    await t.exec('delete from reporting_events');
    const r = createReporting({
      db: t.db,
      log: memoryLog(),
      site: 'test',
      mode: 'test',
      defer: () => {},
    });
    const t0 = new Date('2026-01-01T00:00:00Z');
    for (let i = 0; i < 5; i += 1) {
      r.event({ kind: 'p.q', message: `m${i}`, occurredAt: new Date(t0.getTime() + i * 1000) });
    }
    await r.flush();
    const first = await r.events.page({ limit: 2 });
    expect(first.items.map((x) => x.message)).toEqual(['m4', 'm3']);
    expect(first.next).not.toBeNull();
    // A row arriving now lands at the top and must not shift the cursor.
    r.event({ kind: 'p.q', message: 'm5', occurredAt: new Date(t0.getTime() + 9000) });
    await r.flush();
    const second = await r.events.page({ limit: 2, after: first.next ?? undefined });
    expect(second.items.map((x) => x.message)).toEqual(['m2', 'm1']);
    const third = await r.events.page({ limit: 2, after: second.next ?? undefined });
    expect(third.items.map((x) => x.message)).toEqual(['m0']);
    expect(third.next).toBeNull();
    const byNs = await r.events.page({ kindNs: 'p' });
    expect(byNs.items).toHaveLength(6);
  });

  it('settings: defaults, a bounded set, and the change event', async () => {
    const r = createReporting({
      db: t.db,
      log: memoryLog(),
      site: 'test',
      mode: 'test',
      defer: () => {},
    });
    expect(await r.settings.get()).toEqual({ 'events.retention_days': 30 });
    const by = { class: 'human' as const, id: 'op1' };
    const change = await r.settings.set({ 'events.retention_days': 45 }, by);
    expect(change.changed).toEqual(['events.retention_days']);
    expect(await r.settings.get()).toEqual({ 'events.retention_days': 45 });
    await expect(r.settings.set({ 'events.retention_days': 3 }, by)).rejects.toThrow(
      /between 7 and 400/,
    );
    await expect(r.settings.set({ 'events.retention_days': 401 }, by)).rejects.toThrow();
    const again = await r.settings.set({ 'events.retention_days': 45 }, by);
    expect(again.changed).toEqual([]);
    await r.flush();
    const events = await t.db
      .select({ kind: reportingEvents.kind, data: reportingEvents.data })
      .from(reportingEvents)
      .where(undefined);
    const changeRows = events.filter((e) => e.kind === 'reporting.settings_changed');
    expect(changeRows).toHaveLength(1);
    expect(changeRows[0]?.data).toEqual({
      'events.retention_days.before': 30,
      'events.retention_days.after': 45,
    });
  });
});
