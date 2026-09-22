import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHousekeeping } from '../housekeeping/index.js';
import { createReporting } from '../index.js';
import { type TestDb, memoryLog, testDb } from '../test/db.js';
import type { Reporting } from '../types.js';
import {
  pruneAnalytics,
  rollupAnalytics,
  rollupAnalyticsWeekly,
  safePruneBoundary,
} from './tasks.js';

let t: TestDb;
let reporting: Reporting;
let clock = new Date('2026-09-12T10:00:00Z');
const TENANT = '11111111-1111-4111-8111-111111111111';

beforeAll(async () => {
  t = await testDb();
  reporting = createReporting({
    db: t.db,
    log: memoryLog(),
    site: 'app',
    mode: 'test',
    now: () => clock,
  });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  clock = new Date('2026-09-12T10:00:00Z');
  await t.exec(
    'delete from reporting_analytics; delete from reporting_analytics_daily; delete from reporting_analytics_weekly; delete from reporting_tasks; delete from reporting_events',
  );
});

function hk() {
  const h = createHousekeeping({ reporting, db: t.db, now: () => clock, debounceMs: 0 });
  h.register(rollupAnalytics);
  h.register(rollupAnalyticsWeekly);
  h.register(pruneAnalytics);
  return h;
}

async function raw(
  rows: {
    at: string;
    visitor?: string | null;
    user?: string | null;
    tenant?: string | null;
    name?: string;
    path?: string;
    device?: string;
    country?: string | null;
    ref?: string | null;
  }[],
) {
  for (const r of rows) {
    await t.exec(
      `insert into reporting_analytics (occurred_at, received_at, site, tenant_id, visitor_id, user_id, name, path, device, country, referrer_host) values ('${r.at}', '${r.at}', 'app', ${r.tenant ? `'${r.tenant}'` : 'null'}, ${r.visitor === null || r.visitor === undefined ? 'null' : `'${r.visitor}'`}, ${r.user ? `'${r.user}'` : 'null'}, '${r.name ?? 'page.view'}', '${r.path ?? '/'}', '${r.device ?? 'desktop'}', ${r.country ? `'${r.country}'` : 'null'}, ${r.ref ? `'${r.ref}'` : 'null'})`,
    );
  }
}
const daily = (grain: string, day = '2026-09-10') =>
  t.query(
    `select coalesce(path, name, device, country, referrer_host, tenant_id::text, 'total') as key, views, visitors, people from reporting_analytics_daily where day = '${day}' and grain = '${grain}' order by views desc, key`,
  );
const watermark = (task: string) =>
  t
    .query(`select watermark from reporting_tasks where task = '${task}'`)
    .then((r) => r[0]?.watermark ?? null);

describe('the daily rollup (A3, A4)', () => {
  it('stores distinct counts at every grain, never summed from finer groups', async () => {
    await raw([
      {
        at: '2026-09-10T08:00:00Z',
        visitor: 'v1v1v1v1v1v1v1v1',
        user: 'u1',
        path: '/a',
        device: 'mobile',
        country: 'NO',
        ref: 'google.com',
      },
      {
        at: '2026-09-10T09:00:00Z',
        visitor: 'v1v1v1v1v1v1v1v1',
        user: 'u1',
        path: '/b',
        device: 'mobile',
        country: 'NO',
      },
      {
        at: '2026-09-10T10:00:00Z',
        visitor: 'v1v1v1v1v1v1v1v1',
        user: 'u1',
        path: '/c',
        device: 'desktop',
        country: 'SE',
        ref: 'google.com',
      },
      { at: '2026-09-10T11:00:00Z', visitor: null, user: null, path: '/a' },
      {
        at: '2026-09-10T12:00:00Z',
        visitor: 'v2v2v2v2v2v2v2v2',
        user: null,
        path: '/a',
        tenant: TENANT,
        name: 'invoice.paid',
      },
    ]);
    const h = hk();
    expect(await h.runNow('reporting.rollup_analytics')).toBe('ran');
    // One visitor across three paths counts once at the site level.
    expect(await daily('site')).toEqual([{ key: 'total', views: 5, visitors: 2, people: 1 }]);
    expect(await daily('path')).toEqual([
      { key: '/a', views: 2, visitors: 1, people: 1 },
      { key: '/b', views: 1, visitors: 1, people: 1 },
      { key: '/c', views: 1, visitors: 1, people: 1 },
    ]);
    expect(await daily('device')).toEqual([
      { key: 'desktop', views: 3, visitors: 2, people: 1 },
      { key: 'mobile', views: 2, visitors: 1, people: 1 },
    ]);
    expect(await daily('country')).toEqual([
      { key: 'NO', views: 2, visitors: 1, people: 1 },
      { key: 'ZZ', views: 2, visitors: 1, people: 0 },
      { key: 'SE', views: 1, visitors: 1, people: 1 },
    ]);
    expect(await daily('referrer')).toEqual([
      { key: '(direct)', views: 3, visitors: 2, people: 1 },
      { key: 'google.com', views: 2, visitors: 1, people: 1 },
    ]);
    expect(await daily('tenant')).toEqual([{ key: TENANT, views: 1, visitors: 1, people: 0 }]);
    expect(await daily('name')).toEqual([
      { key: 'page.view', views: 4, visitors: 1, people: 1 },
      { key: 'invoice.paid', views: 1, visitors: 1, people: 0 },
    ]);
    // Completed days up to yesterday are vouched for; today is recomputed but not.
    expect(await watermark('reporting.rollup_analytics')).toBe('2026-09-11');
  });

  it('replaces a day atomically, so a late row that changes the top list leaves no stale bucket', async () => {
    const rows = [];
    for (let i = 0; i < 205; i += 1)
      rows.push({ at: '2026-09-10T08:00:00Z', path: `/p${i}`, visitor: null });
    rows.push({ at: '2026-09-10T08:00:00Z', path: '/p0', visitor: null });
    await raw(rows);
    const h = hk();
    await h.runNow('reporting.rollup_analytics');
    const first = await t.query(
      "select path from reporting_analytics_daily where day = '2026-09-10' and grain = 'path' and path = '(other)'",
    );
    expect(first).toHaveLength(1);
    // The recompute after late rows: /p204 gets 300 more views and is no longer '(other)'.
    const late = [];
    for (let i = 0; i < 300; i += 1)
      late.push({ at: '2026-09-10T09:00:00Z', path: '/p204', visitor: null });
    await raw(late);
    await t.exec("update reporting_tasks set watermark = '2026-09-09', next_due_at = now()");
    await h.runNow('reporting.rollup_analytics');
    const buckets = await t.query(
      "select path, views from reporting_analytics_daily where day = '2026-09-10' and grain = 'path' and (path = '/p204' or path = '(other)') order by path",
    );
    expect(buckets.find((b) => b.path === '/p204')?.views).toBe(301);
    expect(
      await t.query(
        "select sum(views)::int as v from reporting_analytics_daily where day = '2026-09-10' and grain = 'path'",
      ),
    ).toEqual([{ v: 506 }]);
  });

  it('catches up every missed day in bounded batches and moves the watermark contiguously', async () => {
    await raw([
      { at: '2026-08-20T08:00:00Z', visitor: null },
      { at: '2026-08-25T08:00:00Z', visitor: null },
      { at: '2026-09-11T08:00:00Z', visitor: null },
    ]);
    const h = hk();
    await h.runNow('reporting.rollup_analytics');
    // 14 days per run: 2026-08-20 .. 2026-09-02.
    expect(await watermark('reporting.rollup_analytics')).toBe('2026-09-02');
    await t.exec('update reporting_tasks set next_due_at = now()');
    await h.runNow('reporting.rollup_analytics');
    expect(await watermark('reporting.rollup_analytics')).toBe('2026-09-11');
    const days = await t.query(
      "select day::text as d from reporting_analytics_daily where grain = 'site' order by day",
    );
    expect(days.map((r) => r.d)).toEqual(['2026-08-20', '2026-08-25', '2026-09-11']);
  });

  it('a lost lease stops the run before the watermark moves', async () => {
    await raw([{ at: '2026-09-10T08:00:00Z', visitor: null }]);
    const h = hk();
    // Another process takes over: the claim token changes under the running task.
    const stolen = createHousekeeping({ reporting, db: t.db, now: () => clock, debounceMs: 0 });
    stolen.register({
      ...rollupAnalytics,
      name: 'reporting.rollup_analytics',
      async run(ctx) {
        await t.exec(
          "update reporting_tasks set claim_token = gen_random_uuid() where task = 'reporting.rollup_analytics'",
        );
        const moved = await ctx.commitWatermark('2026-09-10');
        expect(moved).toBe(false);
      },
    });
    await stolen.runNow('reporting.rollup_analytics');
    expect(await watermark('reporting.rollup_analytics')).toBeNull();
    void h;
  });
});

describe('the weekly rollup and returning visitors', () => {
  it('counts a visitor seen in an earlier week as returning, per site and per tenant', async () => {
    await raw([
      { at: '2026-08-25T08:00:00Z', visitor: 'v1v1v1v1v1v1v1v1', user: 'u1' },
      { at: '2026-09-01T08:00:00Z', visitor: 'v1v1v1v1v1v1v1v1', user: 'u1', tenant: TENANT },
      { at: '2026-09-02T08:00:00Z', visitor: 'v2v2v2v2v2v2v2v2', user: null, tenant: TENANT },
    ]);
    const h = hk();
    await h.runNow('reporting.rollup_analytics_weekly');
    const week = await t.query(
      "select tenant_id, visitors, returning_visitors, people, returning_people from reporting_analytics_weekly where week = '2026-08-31' order by tenant_id nulls first",
    );
    expect(week).toEqual([
      { tenant_id: null, visitors: 2, returning_visitors: 1, people: 1, returning_people: 1 },
      { tenant_id: TENANT, visitors: 2, returning_visitors: 1, people: 1, returning_people: 1 },
    ]);
    // Today is Saturday the 12th: the week of the 7th is open, the week of the 31st is the last completed.
    expect(await watermark('reporting.rollup_analytics_weekly')).toBe('2026-08-31');
  });
});

describe('pruning never outruns the rollups (A3)', () => {
  it('refuses until both rollups have a watermark, then prunes only before the earlier boundary', async () => {
    clock = new Date('2026-09-12T10:00:00Z');
    await raw([
      { at: '2026-05-01T08:00:00Z', visitor: null },
      { at: '2026-09-01T08:00:00Z', visitor: null },
    ]);
    const h = hk();
    expect(await safePruneBoundary(t.db)).toBeNull();
    await reporting.settings.set(
      { 'analytics.retention_days': 7 },
      { class: 'service', id: 'test' },
    );
    expect(await h.runNow('reporting.prune_analytics')).toBe('ran');
    expect(await t.query('select count(*)::int as n from reporting_analytics')).toEqual([{ n: 2 }]);
    // Completed history to 2026-09-11 daily and 2026-09-07 weekly: the boundary is the weekly's, less its lookback.
    await t.exec(
      "update reporting_tasks set watermark = '2026-09-11', next_due_at = now() where task = 'reporting.rollup_analytics'",
    );
    await t.exec(
      "update reporting_tasks set watermark = '2026-09-07', next_due_at = now() where task = 'reporting.rollup_analytics_weekly'",
    );
    expect(await safePruneBoundary(t.db)).toBe('2026-08-10');
    // A 7-day window has its cutoff at 2026-09-05, past the boundary: deferred with a warning, nothing deleted.
    await t.exec(
      "update reporting_tasks set next_due_at = now() where task = 'reporting.prune_analytics'",
    );
    expect(await h.runNow('reporting.prune_analytics')).toBe('ran');
    expect(await t.query('select count(*)::int as n from reporting_analytics')).toEqual([{ n: 2 }]);
    expect(
      await t.query(
        "select count(*)::int as n from reporting_events where kind = 'reporting.prune_deferred'",
      ),
    ).toEqual([{ n: 1 }]);
    // The function itself is the backstop.
    await expect(
      t.query("select reporting_prune_analytics(interval '7 days', 10, '2026-08-10')"),
    ).rejects.toThrow(/not before the rollups/);
    // A 90-day window has its cutoff at 2026-06-14, before the boundary: the May row goes.
    await reporting.settings.set(
      { 'analytics.retention_days': 90 },
      { class: 'service', id: 'test' },
    );
    await t.exec(
      "update reporting_tasks set next_due_at = now() where task = 'reporting.prune_analytics'",
    );
    expect(await h.runNow('reporting.prune_analytics')).toBe('ran');
    expect(await t.query('select occurred_at::date::text as d from reporting_analytics')).toEqual([
      { d: '2026-09-01' },
    ]);
  });
});

describe('reporting_prune_analytics: a tenant override (gap issue #11)', () => {
  const TENANT = '55555555-5555-4555-8555-555555555555';

  async function seed(daysAgo: number, path: string, tenant: string | null) {
    await t.exec(
      `insert into reporting_analytics (occurred_at, site, name, path, device, tenant_id) values (now(), 'app', 'page.view', '${path}', 'desktop', ${tenant ? `'${tenant}'` : 'null'})`,
    );
    // occurred_at and received_at move together: reporting_analytics_clock_check
    // (0002_analytics.sql) refuses more than 600 seconds of skew between them.
    await t.exec(
      `update reporting_analytics set occurred_at = now() - interval '${daysAgo} days', received_at = now() - interval '${daysAgo} days' where path = '${path}'`,
    );
  }

  // Tomorrow, so it never blocks any of this block's cutoffs (10-200 days
  // back) -- these tests exercise the per-tenant window directly, not the
  // rollup watermark machinery `safePruneBoundary` covers above.
  const prune = (days: number) =>
    t.query(
      `select reporting_prune_analytics(interval '${days} days', 5000, current_date + 1) as n`,
    );

  it("a tenant's shorter override prunes sooner than the site-wide window", async () => {
    await t.exec('delete from reporting_tenant_settings');
    await seed(10, '/short-override', TENANT);
    await t.exec(
      `insert into reporting_tenant_settings (tenant_id, key, value) values ('${TENANT}', 'analytics.retention_days', to_jsonb(7))`,
    );
    const [n] = await prune(90);
    expect(Number(n?.n)).toBe(1);
  });

  it("a tenant's longer override keeps a row the site-wide window would already have dropped", async () => {
    await t.exec('delete from reporting_tenant_settings');
    await seed(100, '/long-override', TENANT);
    await t.exec(
      `insert into reporting_tenant_settings (tenant_id, key, value) values ('${TENANT}', 'analytics.retention_days', to_jsonb(200))`,
    );
    const [n] = await prune(90);
    expect(Number(n?.n)).toBe(0);
  });

  it('a row with no tenant_id always uses the site-wide window, unaffected by any override', async () => {
    await t.exec('delete from reporting_tenant_settings');
    await t.exec(
      `insert into reporting_tenant_settings (tenant_id, key, value) values ('${TENANT}', 'analytics.retention_days', to_jsonb(400))`,
    );
    await seed(100, '/no-tenant', null);
    const [n] = await prune(90);
    expect(Number(n?.n)).toBe(1);
  });
});

describe('erasure', () => {
  it("deletes the subject's raw rows and leaves the rollups, which hold no identifier", async () => {
    await raw([
      { at: '2026-09-10T08:00:00Z', visitor: 'v1v1v1v1v1v1v1v1', user: 'u1' },
      { at: '2026-09-10T09:00:00Z', visitor: 'v2v2v2v2v2v2v2v2', user: 'u2' },
    ]);
    await hk().runNow('reporting.rollup_analytics');
    expect(await t.query("select reporting_erase_person('u1') as n")).toEqual([{ n: 1 }]);
    expect(await t.query('select user_id from reporting_analytics')).toEqual([{ user_id: 'u2' }]);
    expect(await daily('site')).toEqual([{ key: 'total', views: 2, visitors: 2, people: 2 }]);
  });
});

describe('the readers', () => {
  it('give a customer organisation its own totals and the operator every grain, with small groups hidden for the customer', async () => {
    await raw([
      { at: '2026-09-10T08:00:00Z', visitor: 'v1v1v1v1v1v1v1v1', tenant: TENANT, path: '/a' },
      { at: '2026-09-10T08:00:00Z', visitor: 'v2v2v2v2v2v2v2v2', path: '/a' },
    ]);
    await hk().runNow('reporting.rollup_analytics');
    const tenant = await reporting.analytics.series({
      site: 'app',
      tenantId: TENANT,
      from: '2026-09-01',
      to: '2026-09-12',
    });
    expect(tenant).toEqual([{ day: '2026-09-10', key: 'total', views: 1, visitors: 1, people: 0 }]);
    const paths = await reporting.analytics.series({
      site: 'app',
      grain: 'path',
      from: '2026-09-01',
      to: '2026-09-12',
    });
    expect(paths).toEqual([{ day: '2026-09-10', key: '/a', views: 2, visitors: 2, people: 0 }]);
    const { hideSmallGroups } = await import('./reader.js');
    expect(hideSmallGroups(paths).map((p) => p.key)).toEqual(['(few)']);
    const recent = await reporting.analytics.recent({ site: 'app' });
    expect(recent).toHaveLength(2);
    expect(Object.keys(recent[0] ?? {})).not.toContain('userId');
  });
});

describe('track', () => {
  it('writes a server-side row with the identity the host passes and a normalised path', async () => {
    await reporting.analytics.track({
      name: 'invoice.approved',
      userId: 'u1',
      tenantId: TENANT,
      path: '/org/11111111-1111-4111-8111-111111111111/invoices/7',
      props: { amount: 10 },
    });
    expect(
      await t.query(
        'select user_id, tenant_id, path, name, device, props from reporting_analytics',
      ),
    ).toEqual([
      {
        user_id: 'u1',
        tenant_id: TENANT,
        path: '/org/:id/invoices/:n',
        name: 'invoice.approved',
        device: 'unknown',
        props: { amount: 10 },
      },
    ]);
    await expect(reporting.analytics.track({ name: 'bad name' })).rejects.toThrow(/not a name/);
  });
});
