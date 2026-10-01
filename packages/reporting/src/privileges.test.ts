import { randomUUID } from 'node:crypto';
import { withDrizzle } from '@wtfalch/db/drizzle';
import { createDatabase } from '@wtfalch/db/postgres';
import { assertRuntimeRole, ensureRuntimeRole } from '@wtfalch/db/runtime-role';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pruneAnalyticsBatch } from './analytics/tasks.js';
import { pruneErrorsBatch, pruneOpenErrorsBatch } from './errors/tasks.js';
import { createHousekeeping } from './housekeeping/index.js';
import { pruneBatch } from './housekeeping/tasks.js';
import { createReporting } from './index.js';
import { tables } from './tables.js';
import { type TestDb, memoryLog, testDb } from './test/db.js';

/**
 * What a host's `ensureRuntimeRole` call must leave the runtime role able
 * and unable to do, on a real Postgres only, in a named schema, through a
 * role that owns nothing. The lists below are the ones the README tells a
 * host to pass; this file is their test.
 *
 * `noDelete` arrived in @wtfalch/db 0.5.1, which is not published, so the
 * five insert-and-update tables get one plain REVOKE after the call. A host
 * on 0.5.1 passes `noDelete` instead and drops that statement.
 */

const URL_ = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_)('the runtime role', () => {
  // Evaluated even when skipped, so tolerate the variable being absent.
  const url = URL_ ?? 'postgres://skipped:skipped@localhost/skipped';
  const rt = `reporting_rt_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let t: TestDb;
  let schema: string;
  let runtime: ReturnType<typeof createDatabase>;
  let orm: ReturnType<typeof withDrizzle<typeof tables>>['orm'];

  const q = (text: string) => runtime.database.query(text);

  beforeAll(async () => {
    t = await testDb();
    schema = t.schema as string;
    const u = new URL(url);
    u.username = rt;
    u.password = 'rt';
    const runtimeUrl = u.toString();
    const fn = (signature: string) => `${schema}.${signature}`;
    await ensureRuntimeRole({
      ownerUrl: url,
      runtimeUrl,
      schemas: [schema],
      appendOnly: ['reporting_events', 'reporting_analytics'],
      readOnly: ['reporting_analytics_daily', 'reporting_analytics_weekly'],
      grants: [
        fn('reporting_prune_events(interval, integer)'),
        fn('reporting_rollup_day(date)'),
        fn('reporting_rollup_week(date)'),
        fn('reporting_prune_analytics(interval, integer, date)'),
        fn('reporting_erase_person(text)'),
        fn('reporting_prune_errors(interval, integer)'),
        fn('reporting_prune_open_errors(integer, integer)'),
      ],
      log: () => undefined,
    });
    // `noDelete` (db 0.5.1) for these five: update stays, delete and truncate go.
    await t.exec(
      `revoke delete, truncate on "${schema}".reporting_tasks, "${schema}".reporting_settings, "${schema}".reporting_errors, "${schema}".reporting_tenant_settings, "${schema}".reporting_error_tenants from "${rt}"`,
    );
    runtime = createDatabase({
      url: () => runtimeUrl,
      searchPath: [schema],
      max: 4,
      applicationName: 'reporting-test-runtime',
    });
    orm = withDrizzle(runtime, { schema: tables }).orm;
  });
  afterAll(async () => {
    await runtime?.close({ timeoutMs: 5000 });
    // The role is cluster-wide, so it must not outlive the run: drop its grants
    // and default privileges in this database, then the schema, then the role.
    await t?.exec(`drop owned by "${rt}"`);
    await t?.close();
    const cleanup = createDatabase({ url: () => url, max: 1, applicationName: 'reporting-test' });
    try {
      await cleanup.database.query(`drop role if exists "${rt}"`);
    } finally {
      await cleanup.close({ timeoutMs: 5000 });
    }
  });

  it('holds what the lists say and owns nothing', async () => {
    await assertRuntimeRole(runtime.database, {
      appendOnly: [`${schema}.reporting_events`, `${schema}.reporting_analytics`],
      readOnly: [`${schema}.reporting_analytics_daily`, `${schema}.reporting_analytics_weekly`],
    });
  });

  it('can insert and read events, cannot update, delete or truncate them', async () => {
    await q(
      `insert into reporting_events (level, kind, site, message) values ('info', 'a.b', 'test', 'm')`,
    );
    const rows = await q('select count(*)::int as n from reporting_events');
    expect(Number(rows[0]?.n)).toBe(1);
    await expect(q(`update reporting_events set message = 'x'`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(q('delete from reporting_events')).rejects.toThrow(/permission denied/);
    await expect(q('truncate reporting_events')).rejects.toThrow(/permission denied/);
  });

  it('can claim tasks and edit settings, cannot delete either', async () => {
    await q(`insert into reporting_tasks (task) values ('a.b')`);
    await q(`update reporting_tasks set claim_token = gen_random_uuid() where task = 'a.b'`);
    await q(`insert into reporting_settings (key, value) values ('events.retention_days', '30')`);
    await q(`update reporting_settings set value = '45' where key = 'events.retention_days'`);
    await expect(q('delete from reporting_tasks')).rejects.toThrow(/permission denied/);
    await expect(q('delete from reporting_settings')).rejects.toThrow(/permission denied/);
  });

  it('can run the prune function; public cannot', async () => {
    await t.exec(`update reporting_events set occurred_at = now() - interval '100 days'`);
    const rows = await q(`select reporting_prune_events(interval '30 days', 100) as n`);
    expect(Number(rows[0]?.n)).toBe(1);
    const fn = `"${schema}".reporting_prune_events(interval, integer)`;
    const acl = await t.query(
      `select has_function_privilege('${rt}', '${fn}', 'execute') as rt,
              has_function_privilege('public', '${fn}', 'execute') as pub`,
    );
    expect(acl[0]).toMatchObject({ rt: true, pub: false });
  });

  it('the drizzle handle over the runtime role behaves the same', async () => {
    await expect(orm.execute('delete from reporting_events' as never)).rejects.toThrow();
  });

  it('analytics: inserts and reads raw rows, reads but never writes the rollups, and runs the four functions', async () => {
    await q(
      "insert into reporting_analytics (occurred_at, site, name, path, device, user_id) values (now(), 'app', 'page.view', '/', 'desktop', 'u1')",
    );
    expect((await q('select count(*)::int as n from reporting_analytics'))[0]?.n).toBe(1);
    await expect(q("update reporting_analytics set path = '/x'")).rejects.toThrow(
      /permission denied/,
    );
    await expect(q('delete from reporting_analytics')).rejects.toThrow(/permission denied/);
    await expect(
      q(
        "insert into reporting_analytics_daily (day, site, grain, views, visitors, people) values (current_date, 'app', 'site', 1, 1, 1)",
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(q('delete from reporting_analytics_weekly')).rejects.toThrow(/permission denied/);
    expect((await q('select reporting_rollup_day(current_date) as n'))[0]?.n).toBeGreaterThan(0);
    expect(
      (await q('select count(*)::int as n from reporting_analytics_daily'))[0]?.n,
    ).toBeGreaterThan(0);
    await q(`select reporting_rollup_week((date_trunc('week', current_date))::date)`);
    await expect(
      q("select reporting_prune_analytics(interval '7 days', 10, current_date - 100)"),
    ).rejects.toThrow(/not before the rollups/);
    expect((await q("select reporting_erase_person('u1') as n"))[0]?.n).toBe(1);
  });

  it('errors: can select, insert and update, cannot delete or truncate', async () => {
    const fp = '0'.repeat(32);
    await q(
      `insert into reporting_errors (fingerprint, site, kind, message, runtime, first_seen_at, last_seen_at) values ('${fp}', 'test', 'TypeError', 'boom', 'server', now(), now())`,
    );
    expect((await q('select count(*)::int as n from reporting_errors'))[0]?.n).toBe(1);
    await q(
      `update reporting_errors set state = 'resolved', resolved_at = now(), resolved_by = 'op1' where fingerprint = '${fp}'`,
    );
    await expect(q('delete from reporting_errors')).rejects.toThrow(/permission denied/);
    await expect(q('truncate reporting_errors')).rejects.toThrow(/permission denied/);
  });

  it('tenant settings and error tenants: readable, cannot delete', async () => {
    await expect(q('delete from reporting_tenant_settings')).rejects.toThrow(/permission denied/);
    await expect(q('delete from reporting_error_tenants')).rejects.toThrow(/permission denied/);
    await q('select count(*) from reporting_tenant_settings');
  });

  // The native Drizzle paths that need more than plain DML, through the
  // runtime role in a named schema: FOR UPDATE SKIP LOCKED, a savepoint,
  // and SET LOCAL statement_timeout inside a transaction.
  it('housekeeping claims a task with FOR UPDATE SKIP LOCKED', async () => {
    const reporting = createReporting({
      db: orm,
      log: memoryLog(),
      site: 'test',
      mode: 'test',
      defer: () => {},
    });
    const hk = createHousekeeping({ reporting, db: orm, debounceMs: 0 });
    let ran = 0;
    hk.register({
      name: 'priv.once',
      every: 3600_000,
      lease: 60_000,
      retry: 600_000,
      run: async () => {
        ran += 1;
      },
    });
    expect(await hk.runNow('priv.once')).toBe('ran');
    expect(ran).toBe(1);
  });

  it('captureError upserts the group and writes the tenant row in a savepoint', async () => {
    const pending: Promise<void>[] = [];
    const reporting = createReporting({
      db: orm,
      log: memoryLog(),
      site: 'test',
      mode: 'test',
      defer: (fn) => void pending.push(fn()),
    });
    const tenantId = randomUUID();
    reporting.captureError(new TypeError('boom'), { tenantId });
    reporting.captureError(new TypeError('boom'), { tenantId });
    await Promise.all(pending);
    const rows = await t.query('select occurrences from reporting_error_tenants');
    expect(rows.map((r) => Number(r.occurrences))).toEqual([2]);
  });

  it('every prune batch sets a local statement_timeout and runs its definer function', async () => {
    expect(await pruneBatch(orm, 30, 10)).toBeGreaterThanOrEqual(0);
    expect(await pruneErrorsBatch(orm, 30, 10)).toBeGreaterThanOrEqual(0);
    expect(await pruneOpenErrorsBatch(orm, 100, 10)).toBeGreaterThanOrEqual(0);
    const today = new Date().toISOString().slice(0, 10);
    expect(await pruneAnalyticsBatch(orm, 30, 10, today)).toBeGreaterThanOrEqual(0);
  });
});
