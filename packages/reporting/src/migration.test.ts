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

describe('0003_errors.sql', () => {
  const fp = (n: number) => n.toString(16).padStart(32, '0');
  const errBase =
    'insert into reporting_errors (fingerprint, site, kind, message, runtime, first_seen_at, last_seen_at) values';

  it('applies twice without complaint', async () => {
    await t.exec(MIGRATION_SQL);
  });

  it('accepts a minimal row and defaults occurrences and state', async () => {
    await t.exec(`${errBase} ('${fp(0)}', 'test', 'TypeError', 'boom', 'server', now(), now())`);
    const rows = await t.query(
      `select occurrences, state from reporting_errors where fingerprint = '${fp(0)}'`,
    );
    expect(Number(rows[0]?.occurrences)).toBe(1);
    expect(rows[0]?.state).toBe('open');
  });

  it.each([
    [
      'an upper-case fingerprint',
      `${errBase} ('${fp(0xabc).toUpperCase()}', 'test', 'TypeError', 'boom', 'server', now(), now())`,
    ],
    [
      'a fingerprint the wrong length',
      `${errBase} ('abc', 'test', 'TypeError', 'boom', 'server', now(), now())`,
    ],
    [
      'an upper-case site',
      `${errBase} ('${fp(3)}', 'Test', 'TypeError', 'boom', 'server', now(), now())`,
    ],
    [
      'an empty message',
      `${errBase} ('${fp(4)}', 'test', 'TypeError', '', 'server', now(), now())`,
    ],
    [
      'a message over 512',
      `${errBase} ('${fp(5)}', 'test', 'TypeError', repeat('x', 513), 'server', now(), now())`,
    ],
    [
      'a stack over 16384',
      `insert into reporting_errors (fingerprint, site, kind, message, stack, runtime, first_seen_at, last_seen_at) values ('${fp(6)}', 'test', 'TypeError', 'boom', repeat('x', 16385), 'server', now(), now())`,
    ],
    [
      'a runtime outside the three',
      `${errBase} ('${fp(7)}', 'test', 'TypeError', 'boom', 'client', now(), now())`,
    ],
    [
      'a state outside the three',
      `insert into reporting_errors (fingerprint, site, kind, message, runtime, first_seen_at, last_seen_at, state) values ('${fp(8)}', 'test', 'TypeError', 'boom', 'server', now(), now(), 'archived')`,
    ],
    [
      'occurrences not positive',
      `insert into reporting_errors (fingerprint, site, kind, message, runtime, first_seen_at, last_seen_at, occurrences) values ('${fp(9)}', 'test', 'TypeError', 'boom', 'server', now(), now(), 0)`,
    ],
    [
      'last_seen_at before first_seen_at',
      `${errBase} ('${fp(10)}', 'test', 'TypeError', 'boom', 'server', now(), now() - interval '1 day')`,
    ],
    [
      'resolved_at without resolved_by',
      `insert into reporting_errors (fingerprint, site, kind, message, runtime, first_seen_at, last_seen_at, resolved_at) values ('${fp(11)}', 'test', 'TypeError', 'boom', 'server', now(), now(), now())`,
    ],
    [
      'resolved_by without resolved_at',
      `insert into reporting_errors (fingerprint, site, kind, message, runtime, first_seen_at, last_seen_at, resolved_by) values ('${fp(12)}', 'test', 'TypeError', 'boom', 'server', now(), now(), 'op1')`,
    ],
  ])('refuses %s', async (_name, statement) => {
    await expect(t.exec(statement)).rejects.toThrow();
  });
});

describe('0004_environment.sql', () => {
  const fp = (n: number) => n.toString(16).padStart(32, '0');
  const errBase =
    'insert into reporting_errors (fingerprint, site, kind, message, runtime, first_seen_at, last_seen_at) values';

  it('applies twice without complaint', async () => {
    await t.exec(MIGRATION_SQL);
  });

  it('accepts a null or a slug-shaped environment on both tables', async () => {
    await t.exec(`${base} ('info', 'a.b', 'test', 'm')`);
    await t.exec(
      `insert into reporting_events (level, kind, site, message, environment) values ('info', 'a.b', 'test', 'm', 'production')`,
    );
    await t.exec(`${errBase} ('${fp(20)}', 'test', 'TypeError', 'boom', 'server', now(), now())`);
    await t.exec(
      `insert into reporting_errors (fingerprint, site, kind, message, runtime, first_seen_at, last_seen_at, environment) values ('${fp(21)}', 'test', 'TypeError', 'boom', 'server', now(), now(), 'preview')`,
    );
  });

  it.each([
    [
      'an upper-case environment',
      `insert into reporting_events (level, kind, site, message, environment) values ('info', 'a.b', 'test', 'm', 'Production')`,
    ],
    [
      'an environment over 32 characters',
      `insert into reporting_events (level, kind, site, message, environment) values ('info', 'a.b', 'test', 'm', repeat('a', 33))`,
    ],
    [
      'an environment starting with a digit',
      `insert into reporting_events (level, kind, site, message, environment) values ('info', 'a.b', 'test', 'm', '1prod')`,
    ],
  ])('refuses %s on reporting_events', async (_name, statement) => {
    await expect(t.exec(statement)).rejects.toThrow();
  });

  it('refuses an upper-case environment on reporting_errors', async () => {
    await expect(
      t.exec(
        `insert into reporting_errors (fingerprint, site, kind, message, runtime, first_seen_at, last_seen_at, environment) values ('${fp(22)}', 'test', 'TypeError', 'boom', 'server', now(), now(), 'Production')`,
      ),
    ).rejects.toThrow();
  });
});

describe('0006_tenant_settings.sql', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const upsert = (value: string) =>
    `insert into reporting_tenant_settings (tenant_id, key, value) values ('${TENANT}', 'events.retention_days', ${value})`;

  it('applies twice without complaint', async () => {
    await t.exec(MIGRATION_SQL);
  });

  it('accepts a JSON null value and a number within bounds', async () => {
    await t.exec('delete from reporting_tenant_settings');
    await t.exec(upsert("'null'::jsonb"));
    await t.exec('delete from reporting_tenant_settings');
    await t.exec(upsert('to_jsonb(45)'));
    const rows = await t.query(
      `select value from reporting_tenant_settings where tenant_id = '${TENANT}'`,
    );
    expect(rows[0]?.value).toBe(45);
  });

  it.each([
    ['a number below the floor', 'to_jsonb(6)'],
    ['a number above the ceiling', 'to_jsonb(401)'],
    ['a string, neither null nor a number', "to_jsonb('45'::text)"],
    ['a boolean', 'to_jsonb(true)'],
    ['an object', "'{}'::jsonb"],
  ])('refuses %s', async (_name, value) => {
    await t.exec('delete from reporting_tenant_settings');
    await expect(t.exec(upsert(value))).rejects.toThrow();
  });

  it('refuses a key outside the two retention settings', async () => {
    await t.exec('delete from reporting_tenant_settings');
    await expect(
      t.exec(
        `insert into reporting_tenant_settings (tenant_id, key, value) values ('${TENANT}', 'analytics.consent', to_jsonb('always'::text))`,
      ),
    ).rejects.toThrow();
  });
});

describe('reporting_prune_events', () => {
  const TENANT = '22222222-2222-4222-8222-222222222222';

  async function seed(daysAgo: number, message: string) {
    await t.exec(`${base} ('info', 'a.b', 'test', '${message}')`.replace('values', 'values'));
    await t.exec(
      `update reporting_events set occurred_at = now() - interval '${daysAgo} days' where message = '${message}'`,
    );
  }

  async function seedTenant(daysAgo: number, message: string) {
    await t.exec(
      `insert into reporting_events (level, kind, site, message, tenant_id) values ('info', 'a.b', 'test', '${message}', '${TENANT}')`,
    );
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

  it("a tenant's shorter override prunes sooner than the site-wide window", async () => {
    await t.exec('delete from reporting_events');
    await t.exec('delete from reporting_tenant_settings');
    await seedTenant(10, 'tenant-row');
    await t.exec(
      `insert into reporting_tenant_settings (tenant_id, key, value) values ('${TENANT}', 'events.retention_days', to_jsonb(7))`,
    );
    // The site-wide window (30 days) would not touch a 10-day-old row; the
    // tenant's own 7-day override does.
    const [n] = await t.query(`select reporting_prune_events(interval '30 days', 5000) as n`);
    expect(Number(n?.n)).toBe(1);
  });

  it("a tenant's longer override keeps a row the site-wide window would already have dropped", async () => {
    await t.exec('delete from reporting_events');
    await t.exec('delete from reporting_tenant_settings');
    await seedTenant(35, 'tenant-row');
    await t.exec(
      `insert into reporting_tenant_settings (tenant_id, key, value) values ('${TENANT}', 'events.retention_days', to_jsonb(200))`,
    );
    // The site-wide window (30 days) would drop a 35-day-old row; the
    // tenant's own 200-day override keeps it.
    const [n] = await t.query(`select reporting_prune_events(interval '30 days', 5000) as n`);
    expect(Number(n?.n)).toBe(0);
    expect(
      (
        await t.query(
          `select count(*)::int as n from reporting_events where tenant_id = '${TENANT}'`,
        )
      )[0]?.n,
    ).toBe(1);
  });

  it('a row with no tenant_id always uses the site-wide window, unaffected by any override', async () => {
    await t.exec('delete from reporting_events');
    await t.exec('delete from reporting_tenant_settings');
    // An override for a DIFFERENT tenant must never leak onto a row with no
    // tenant_id at all -- the left join finds nothing for a null key.
    await t.exec(
      `insert into reporting_tenant_settings (tenant_id, key, value) values ('${TENANT}', 'events.retention_days', to_jsonb(400))`,
    );
    await seed(35, 'no-tenant-row');
    const [n] = await t.query(`select reporting_prune_events(interval '30 days', 5000) as n`);
    expect(Number(n?.n)).toBe(1);
  });

  it('a cleared override (JSON null) falls back to the site-wide window again', async () => {
    await t.exec('delete from reporting_events');
    await t.exec('delete from reporting_tenant_settings');
    await seedTenant(35, 'tenant-row');
    await t.exec(
      `insert into reporting_tenant_settings (tenant_id, key, value) values ('${TENANT}', 'events.retention_days', 'null'::jsonb)`,
    );
    const [n] = await t.query(`select reporting_prune_events(interval '30 days', 5000) as n`);
    expect(Number(n?.n)).toBe(1);
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

  it('stamps environment on every event and every error group, and filters by it', async () => {
    await t.exec('delete from reporting_events');
    await t.exec('delete from reporting_errors');
    const pending: Promise<void>[] = [];
    const r = createReporting({
      db: t.db,
      log: memoryLog(),
      site: 'test',
      environment: 'preview',
      mode: 'test',
      defer: (fn) => pending.push(fn()),
    });
    r.event({ kind: 'mail.write_refused', message: 'no' });
    r.captureError(new TypeError('boom'));
    await Promise.all(pending.splice(0, pending.length));
    await r.flush();

    // The event, the capture's own row, and the alert a new error group fires.
    const page = await r.events.page({});
    expect(page.items.every((row) => row.environment === 'preview')).toBe(true);
    expect((await r.events.page({ environment: 'preview' })).items).toHaveLength(3);
    expect((await r.events.page({ environment: 'production' })).items).toHaveLength(0);

    const errors = await t.query('select environment from reporting_errors');
    expect(errors).toEqual([{ environment: 'preview' }]);
  });

  it('refuses a malformed environment at construction', () => {
    expect(() =>
      createReporting({
        db: t.db,
        log: memoryLog(),
        site: 'test',
        environment: 'Production',
        mode: 'test',
        defer: () => {},
      }),
    ).toThrow();
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
    expect(await r.settings.get()).toMatchObject({ 'events.retention_days': 30 });
    const by = { class: 'human' as const, id: 'op1' };
    const change = await r.settings.set({ 'events.retention_days': 45 }, by);
    expect(change.changed).toEqual(['events.retention_days']);
    expect(await r.settings.get()).toMatchObject({ 'events.retention_days': 45 });
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

  it("tenantSettings: absent by default, a bounded set, a clear, and one tenant never sees another's", async () => {
    await t.exec('delete from reporting_tenant_settings');
    const r = createReporting({
      db: t.db,
      log: memoryLog(),
      site: 'test',
      mode: 'test',
      defer: () => {},
    });
    const by = { class: 'human' as const, id: 'op1' };
    const tenantA = '33333333-3333-4333-8333-333333333333';
    const tenantB = '44444444-4444-4444-8444-444444444444';

    expect(await r.tenantSettings.get(tenantA)).toEqual({});

    await r.tenantSettings.set(tenantA, 'events.retention_days', 200, by);
    expect(await r.tenantSettings.get(tenantA)).toEqual({ 'events.retention_days': 200 });
    expect(await r.tenantSettings.get(tenantB)).toEqual({});

    await expect(r.tenantSettings.set(tenantA, 'events.retention_days', 3, by)).rejects.toThrow(
      /between 7 and 400/,
    );
    await expect(r.tenantSettings.set(tenantA, 'events.retention_days', 401, by)).rejects.toThrow();
    // The rejected attempts above must not have moved the still-valid override.
    expect(await r.tenantSettings.get(tenantA)).toEqual({ 'events.retention_days': 200 });

    await r.tenantSettings.set(tenantA, 'events.retention_days', null, by);
    expect(await r.tenantSettings.get(tenantA)).toEqual({});
    // Clearing is a value update, never a delete (0006_tenant_settings.sql's
    // "nothing that deletes" convention) -- the row is still there.
    const rows = await t.query(
      `select value from reporting_tenant_settings where tenant_id = '${tenantA}'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBeNull();
  });
});

describe('0005_analytics_session_index.sql', () => {
  it('applies twice without complaint', async () => {
    await t.exec(MIGRATION_SQL);
  });

  it('creates the session-scoped partial index', async () => {
    const rows = await t.query(
      `select indexname from pg_indexes where tablename = 'reporting_analytics' and indexname = 'reporting_analytics_session_time_idx'`,
    );
    expect(rows).toHaveLength(1);
  });
});
