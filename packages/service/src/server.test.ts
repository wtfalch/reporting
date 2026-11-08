import { createCapture, scopedFingerprint } from '@wtfalch/reporting-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeCursor } from './reads.js';
import { createReportingHandler } from './server.js';
import { tenantIdOf } from './site-keys.js';
import { type TestDb, memoryLog, testDb } from './test/db.js';

const OPERATOR = 'operator-key-for-tests';
const TENANT = tenantIdOf('org_acme');
const BASE = 'https://reporting.test';

let t: TestDb;
let log: ReturnType<typeof memoryLog>;
let clock: Date;
let handle: (request: Request) => Promise<Response>;
let shopKey: string;
let shopStageKey: string;
let blogKey: string;

beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t.close();
});

async function mint(name: string, site: string, environment: string): Promise<string> {
  const res = await handle(
    new Request(`${BASE}/v1/site-keys`, {
      method: 'POST',
      headers: { authorization: `Bearer ${OPERATOR}` },
      body: JSON.stringify({ name, site, environment }),
    }),
  );
  return ((await res.json()) as { secret: string }).secret;
}

beforeEach(async () => {
  await t.exec('delete from reporting_events');
  await t.exec('delete from reporting_error_tenants');
  await t.exec('delete from reporting_errors');
  await t.exec('delete from reporting_site_keys');
  log = memoryLog();
  clock = new Date('2026-11-02T12:00:00.000Z');
  handle = createReportingHandler({
    db: t.db,
    operatorKey: OPERATOR,
    tenantId: TENANT,
    log,
    now: () => clock,
  });
  shopKey = await mint('shop', 'shop', 'production');
  shopStageKey = await mint('shop-stage', 'shop', 'stage');
  blogKey = await mint('blog', 'blog', 'production');
});

function send(key: string, errors: unknown[] | unknown): Promise<Response> {
  return handle(
    new Request(`${BASE}/v1/errors`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(Array.isArray(errors) ? { errors } : errors),
    }),
  );
}

function get(path: string, key = OPERATOR): Promise<Response> {
  return handle(new Request(`${BASE}${path}`, { headers: { authorization: `Bearer ${key}` } }));
}

function post(path: string, body: unknown, key = OPERATOR): Promise<Response> {
  return handle(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    }),
  );
}

const STACK = [
  'TypeError: cannot read x',
  '    at render (/app/src/pages/cart.ts:10:5)',
  '    at handle (/app/src/server.ts:40:3)',
].join('\n');

async function onlyGroup(site = 'shop') {
  const res = await get(`/v1/errors?site=${site}`);
  const body = (await res.json()) as { items: Record<string, unknown>[] };
  expect(body.items).toHaveLength(1);
  return body.items[0] as Record<string, unknown>;
}

describe('POST /v1/errors', () => {
  it('counts different people per group, keeping only a hash of who', async () => {
    const r = (person?: string) => ({
      kind: 'TypeError',
      message: 'cannot read x',
      runtime: 'server',
      ...(person ? { person } : {}),
    });
    expect((await send(shopKey, [r('user-1'), r('user-1'), r('user-2'), r()])).status).toBe(202);
    // The same people in the workspace are another group with its own count.
    expect((await send(shopStageKey, [r('user-1')])).status).toBe(202);
    // A group no report named a person for counts as unknown, not zero.
    expect(
      (await send(shopKey, [{ kind: 'RangeError', message: 'far', runtime: 'server' }])).status,
    ).toBe(202);
    const live = (await (await get('/v1/errors?site=shop&environment=production')).json()) as {
      items: { kind: string; fingerprint: string; people: number | null }[];
    };
    const byKind = Object.fromEntries(live.items.map((g) => [g.kind, g.people]));
    expect(byKind).toEqual({ TypeError: 2, RangeError: null });
    const stage = (await (await get('/v1/errors?site=shop&environment=stage')).json()) as {
      items: { people: number | null }[];
    };
    expect(stage.items.map((g) => g.people)).toEqual([1]);
    const type = live.items.find((g) => g.kind === 'TypeError');
    const one = (await (await get(`/v1/errors/${type?.fingerprint}?site=shop`)).json()) as {
      people: number;
    };
    expect(one.people).toBe(2);
    const stored = JSON.stringify(await t.query('select data from reporting_events'));
    expect(stored).not.toContain('user-1');
    expect(stored).toMatch(/"person":"[0-9a-f]{32}"/);
    const tooLong = await send(shopKey, [r('x'.repeat(257))]);
    expect(tooLong.status).toBe(400);
  });

  it('answers 202 { accepted } and writes a group and an error.* timeline row', async () => {
    const res = await send(shopKey, [
      {
        kind: 'TypeError',
        message: 'cannot read x',
        stack: STACK,
        runtime: 'edge',
        release: 'v1.2.3',
        color: 'green',
        requestId: 'req-1',
        occurredAt: '2026-11-02T11:59:00.000Z',
      },
    ]);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1 });
    const group = await onlyGroup();
    expect(group).toMatchObject({
      site: 'shop',
      environment: 'production',
      kind: 'TypeError',
      message: 'cannot read x',
      stack: STACK,
      runtime: 'edge',
      release: 'v1.2.3',
      occurrences: 1,
      firstSeenAt: '2026-11-02T11:59:00.000Z',
      lastSeenAt: '2026-11-02T11:59:00.000Z',
      requestId: 'req-1',
      state: 'open',
      resolvedAt: null,
      resolvedBy: null,
      people: null,
    });
    expect(Object.keys(group).sort()).toEqual(
      [
        'fingerprint',
        'site',
        'environment',
        'kind',
        'message',
        'stack',
        'runtime',
        'release',
        'occurrences',
        'firstSeenAt',
        'lastSeenAt',
        'requestId',
        'state',
        'resolvedAt',
        'resolvedBy',
        'people',
        'contexts',
        'retries',
      ].sort(),
    );
    const [row] = await t.query('select color, tenant_id from reporting_errors');
    expect(row).toEqual({ color: 'green', tenant_id: TENANT });
    const events = await t.query(
      'select kind, level, site, environment, release, color, tenant_id, data, occurred_at from reporting_events',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'error.type_error',
      level: 'error',
      site: 'shop',
      environment: 'production',
      release: 'v1.2.3',
      color: 'green',
      tenant_id: TENANT,
      data: { fingerprint: group.fingerprint, runtime: 'edge' },
    });
    expect(new Date(events[0]?.occurred_at as string).toISOString()).toBe(
      '2026-11-02T11:59:00.000Z',
    );
  });

  it("keys a group by core's fingerprint scoped to the key's site and environment", async () => {
    const error = new TypeError('user 4821 not found');
    error.stack = STACK;
    let fp = '';
    const capture = createCapture({
      db: t.db,
      log: memoryLog(),
      site: 'shop',
      now: () => clock,
      defer: () => undefined,
      event: (input) => {
        fp = String(input.data?.fingerprint);
      },
    });
    capture(error);
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
    await send(shopKey, [
      { kind: 'TypeError', message: error.message, stack: error.stack, runtime: 'server' },
    ]);
    expect((await onlyGroup()).fingerprint).toBe(
      scopedFingerprint({ site: 'shop', environment: 'production' }, fp),
    );
  });

  it('the same error from two sites is two groups, and from production and stage of one site two more', async () => {
    const report = { kind: 'TypeError', message: 'cannot read x', stack: STACK, runtime: 'server' };
    await send(shopKey, [report, report]);
    await send(shopStageKey, [report]);
    await send(blogKey, [report]);
    const rows = await t.query(
      'select fingerprint, site, environment, occurrences from reporting_errors order by site, environment',
    );
    expect(rows.map((r) => [r.site, r.environment, Number(r.occurrences)])).toEqual([
      ['blog', 'production', 1],
      ['shop', 'production', 2],
      ['shop', 'stage', 1],
    ]);
    expect(new Set(rows.map((r) => r.fingerprint)).size).toBe(3);
    const prod = (await (await get('/v1/errors?site=shop&environment=production')).json()) as {
      items: { fingerprint: string; environment: string }[];
    };
    const stage = (await (await get('/v1/errors?site=shop&environment=stage')).json()) as {
      items: { fingerprint: string; environment: string }[];
    };
    expect(prod.items.map((g) => g.environment)).toEqual(['production']);
    expect(stage.items.map((g) => g.environment)).toEqual(['stage']);
    expect(prod.items[0]?.fingerprint).not.toBe(stage.items[0]?.fingerprint);
    // The fingerprint implies the environment: one site, two groups, each found by its own.
    const both = (await (await get('/v1/errors?site=shop')).json()) as { items: unknown[] };
    expect(both.items).toHaveLength(2);
    for (const fp of [prod.items[0]?.fingerprint, stage.items[0]?.fingerprint]) {
      expect((await get(`/v1/errors/${fp}?site=shop`)).status).toBe(200);
      expect((await get(`/v1/errors/${fp}?site=blog`)).status).toBe(404);
    }
  });

  it('groups repeats into one group with a count, and the kind defaults to Error', async () => {
    const report = { message: 'user 1 not found', runtime: 'server' };
    await send(shopKey, [report, { ...report, message: 'user 2 not found' }]);
    clock = new Date('2026-11-02T12:05:00.000Z');
    await send(shopKey, [report]);
    const group = await onlyGroup();
    expect(group).toMatchObject({ kind: 'Error', occurrences: 3 });
    expect(group.lastSeenAt).toBe('2026-11-02T12:05:00.000Z');
  });

  it('takes site and environment from the key and refuses a report that names its own', async () => {
    await send(shopStageKey, [{ message: 'boom', runtime: 'server' }]);
    expect(
      (await (await get('/v1/errors?site=shop&environment=stage')).json()) as { items: unknown[] },
    ).toMatchObject({ items: [{ site: 'shop', environment: 'stage' }] });
    for (const extra of [{ site: 'blog' }, { environment: 'stage' }, { tenantId: TENANT }]) {
      const res = await send(shopKey, [{ message: 'boom', runtime: 'server', ...extra }]);
      expect(res.status).toBe(400);
    }
  });

  it('redacts PII and the operator key again on ingest, and a presenting key quoted in its own report', async () => {
    const previous = process.env.REPORTING_OPERATOR_KEY;
    process.env.REPORTING_OPERATOR_KEY = 'op-secret-value-0123456789';
    try {
      await send(shopKey, [
        {
          message: `failed for jane@example.com with op-secret-value-0123456789 and ${shopKey}`,
          runtime: 'server',
        },
      ]);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'REPORTING_OPERATOR_KEY');
      else process.env.REPORTING_OPERATOR_KEY = previous;
    }
    const { message } = await onlyGroup();
    expect(message).not.toContain('jane@example.com');
    expect(message).not.toContain('op-secret-value-0123456789');
    expect(message).not.toContain(shopKey);
    expect(message).toContain('[redacted: email]');
    expect(message).toContain('[redacted: site key]');
  });

  it('a time outside the window is the arrival time', async () => {
    await send(shopKey, [
      { message: 'old', runtime: 'server', occurredAt: '2020-01-01T00:00:00Z' },
    ]);
    expect((await onlyGroup()).firstSeenAt).toBe(clock.toISOString());
  });

  it('answers 401 for an unknown, revoked or missing key, and logs no key', async () => {
    expect((await send('ci_rk_unknown', [{ message: 'x', runtime: 'server' }])).status).toBe(401);
    expect((await send('', [{ message: 'x', runtime: 'server' }])).status).toBe(401);
    expect((await send(OPERATOR, [{ message: 'x', runtime: 'server' }])).status).toBe(401);
    const res = await send('ci_rk_unknown', [{ message: 'x', runtime: 'server' }]);
    expect(await res.json()).toEqual({
      error: { code: 'unauthorized', message: 'A valid site key is required' },
    });
    expect(JSON.stringify(log.lines)).not.toContain('ci_rk_');
  });

  it('refuses over 20 reports, over 64 KB, an empty batch and a bad runtime with 400', async () => {
    const one = { message: 'x', runtime: 'server' };
    expect(
      (
        await send(
          shopKey,
          Array.from({ length: 21 }, () => one),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await send(
          shopKey,
          Array.from({ length: 20 }, () => one),
        )
      ).status,
    ).toBe(202);
    expect(
      (await send(shopKey, [{ message: 'x'.repeat(70 * 1024), runtime: 'server' }])).status,
    ).toBe(400);
    expect((await send(shopKey, [])).status).toBe(400);
    expect((await send(shopKey, [{ message: 'x', runtime: 'worker' }])).status).toBe(400);
    expect((await send(shopKey, { errors: [one], site: 'blog' })).status).toBe(400);
  });

  it('writes nothing of a batch when one report fails, answers 503 and logs no error text', async () => {
    // A request id over the timeline's 128 characters passes no schema here
    // (the body schema bounds it), so force a failure the database raises.
    await t.exec(
      "alter table reporting_events add constraint fail_on_marker check (message <> 'fail here')",
    );
    try {
      const res = await send(shopKey, [
        { message: 'fine', runtime: 'server' },
        { message: 'fail here', runtime: 'server' },
      ]);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: { code: 'unavailable', message: 'Service unavailable' },
      });
    } finally {
      await t.exec('alter table reporting_events drop constraint fail_on_marker');
    }
    expect(await t.query('select 1 from reporting_errors')).toEqual([]);
    expect(await t.query('select 1 from reporting_events')).toEqual([]);
    expect(JSON.stringify(log.lines)).not.toContain('fail here');
  });
});

describe('GET /v1/errors', () => {
  async function seed() {
    for (let i = 0; i < 5; i++) {
      clock = new Date(Date.UTC(2026, 10, 2, 12, i));
      await send(shopKey, [{ kind: `Kind${i}`, message: `boom ${i}`, runtime: 'server' }]);
    }
    await send(blogKey, [{ kind: 'BlogError', message: 'blog', runtime: 'browser' }]);
  }

  it('lists one site, newest lastSeenAt first, keyset-paged with an opaque next', async () => {
    await seed();
    const first = (await (await get('/v1/errors?site=shop&limit=2')).json()) as {
      items: { kind: string }[];
      next: string;
    };
    expect(first.items.map((g) => g.kind)).toEqual(['Kind4', 'Kind3']);
    expect(typeof first.next).toBe('string');
    const second = (await (
      await get(`/v1/errors?site=shop&limit=2&after=${encodeURIComponent(first.next)}`)
    ).json()) as { items: { kind: string }[]; next: string };
    expect(second.items.map((g) => g.kind)).toEqual(['Kind2', 'Kind1']);
    const third = (await (
      await get(`/v1/errors?site=shop&limit=2&after=${encodeURIComponent(second.next)}`)
    ).json()) as { items: { kind: string }[]; next: string | null };
    expect(third.items.map((g) => g.kind)).toEqual(['Kind0']);
    expect(third.next).toBeNull();
  });

  it('defaults to open, defaults the limit to 50, and filters on runtime, search and environment', async () => {
    await seed();
    const all = (await (await get('/v1/errors?site=shop')).json()) as { items: unknown[] };
    expect(all.items).toHaveLength(5);
    const blog = (await (await get('/v1/errors?site=blog&runtime=browser')).json()) as {
      items: { kind: string }[];
    };
    expect(blog.items.map((g) => g.kind)).toEqual(['BlogError']);
    expect(
      ((await (await get('/v1/errors?site=blog&runtime=server')).json()) as { items: unknown[] })
        .items,
    ).toEqual([]);
    const search = (await (await get('/v1/errors?site=shop&search=boom%203')).json()) as {
      items: { kind: string }[];
    };
    expect(search.items.map((g) => g.kind)).toEqual(['Kind3']);
    expect(
      ((await (await get('/v1/errors?site=shop&environment=stage')).json()) as { items: unknown[] })
        .items,
    ).toEqual([]);
    expect(
      ((await (await get('/v1/errors?site=shop&state=resolved')).json()) as { items: unknown[] })
        .items,
    ).toEqual([]);
  });

  it('refuses a missing site, a bad limit, state, runtime, environment or cursor with 400', async () => {
    for (const query of [
      '',
      'site=shop&limit=0',
      'site=shop&limit=101',
      'site=shop&limit=1.5',
      'site=shop&state=closed',
      'site=shop&runtime=worker',
      'site=shop&environment=preview',
      'site=shop&after=garbage',
      `site=shop&after=${encodeCursor({ lastSeenAt: new Date(), fingerprint: 'nope' })}`,
    ]) {
      expect((await get(`/v1/errors?${query}`)).status, query).toBe(400);
    }
  });

  it('every operator read refuses a site key and a wrong key with 401', async () => {
    for (const path of [
      '/v1/errors?site=shop',
      '/v1/errors/series?site=shop&from=2026-11-02T00:00:00Z&to=2026-11-02T01:00:00Z',
      '/v1/errors/0123456789abcdef0123456789abcdef?site=shop',
    ]) {
      expect((await get(path, shopKey)).status).toBe(401);
      expect((await get(path, 'nope')).status).toBe(401);
    }
    expect(
      (await post('/v1/errors/0123456789abcdef0123456789abcdef/state', {}, shopKey)).status,
    ).toBe(401);
  });
});

describe('GET /v1/errors/:fingerprint and POST /v1/errors/:fingerprint/state', () => {
  it('reads one group of the site, and 404 for an unknown one or one of another site', async () => {
    await send(shopKey, [{ message: 'boom', runtime: 'server' }]);
    const { fingerprint } = await onlyGroup();
    const res = await get(`/v1/errors/${fingerprint}?site=shop`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ fingerprint, site: 'shop', message: 'boom' });
    expect((await get(`/v1/errors/${fingerprint}?site=blog`)).status).toBe(404);
    expect((await get('/v1/errors/0123456789abcdef0123456789abcdef?site=shop')).status).toBe(404);
    expect((await get('/v1/errors/not-a-fingerprint?site=shop')).status).toBe(404);
    expect((await get(`/v1/errors/${fingerprint}`)).status).toBe(400);
  });

  it('resolved and ignored stamp who and when, open clears both, and each writes an audit row', async () => {
    await send(shopKey, [{ message: 'boom', runtime: 'server' }]);
    const { fingerprint } = await onlyGroup();
    const by = { class: 'human', id: 'user_42', email: 'dropped@example.com' };
    const resolved = await post(`/v1/errors/${fingerprint}/state`, {
      site: 'shop',
      state: 'resolved',
      by,
    });
    expect(resolved.status).toBe(200);
    const body = (await resolved.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      state: 'resolved',
      resolvedBy: { class: 'human', id: 'user_42' },
    });
    expect(typeof body.resolvedAt).toBe('string');
    expect(body.resolvedBy).toEqual({ class: 'human', id: 'user_42' });

    const opened = (await (
      await post(`/v1/errors/${fingerprint}/state`, { site: 'shop', state: 'open', by })
    ).json()) as Record<string, unknown>;
    expect(opened).toMatchObject({ state: 'open', resolvedAt: null, resolvedBy: null });

    const audit = await t.query(
      `select operation, tenant_id, site, fingerprint, state, actor_class, actor_id
         from audit_events where fingerprint = '${fingerprint}' order by id`,
    );
    expect(audit).toEqual([
      {
        operation: 'error.state',
        tenant_id: TENANT,
        site: 'shop',
        fingerprint,
        state: 'resolved',
        actor_class: 'human',
        actor_id: 'user_42',
      },
      {
        operation: 'error.state',
        tenant_id: TENANT,
        site: 'shop',
        fingerprint,
        state: 'open',
        actor_class: 'human',
        actor_id: 'user_42',
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain('boom');
  });

  it('404 for an unknown group or another site, 400 for a bad body, and no audit row for either', async () => {
    await send(shopKey, [{ message: 'boom', runtime: 'server' }]);
    const { fingerprint } = await onlyGroup();
    const by = { class: 'human', id: 'u' };
    // audit_events is append-only, so earlier tests' rows stay: compare counts.
    const audited = () =>
      t.query(`select count(*)::int as n from audit_events where fingerprint = '${fingerprint}'`);
    const before = await audited();
    expect(
      (
        await post('/v1/errors/0123456789abcdef0123456789abcdef/state', {
          site: 'shop',
          state: 'resolved',
          by,
        })
      ).status,
    ).toBe(404);
    expect(
      (await post(`/v1/errors/${fingerprint}/state`, { site: 'blog', state: 'resolved', by }))
        .status,
    ).toBe(404);
    expect(
      (await post(`/v1/errors/${fingerprint}/state`, { site: 'shop', state: 'closed', by })).status,
    ).toBe(400);
    expect(
      (await post(`/v1/errors/${fingerprint}/state`, { site: 'shop', state: 'resolved' })).status,
    ).toBe(400);
    expect(await audited()).toEqual(before);
    expect((await onlyGroup()).state).toBe('open');
  });

  it('a read writes no audit row', async () => {
    await send(shopKey, [{ message: 'boom', runtime: 'server' }]);
    const before = await t.query('select count(*)::int as n from audit_events');
    const { fingerprint } = await onlyGroup();
    await get(`/v1/errors/${fingerprint}?site=shop`);
    await get('/v1/errors/series?site=shop&from=2026-11-02T00:00:00Z&to=2026-11-03T00:00:00Z');
    expect(await t.query('select count(*)::int as n from audit_events')).toEqual(before);
  });
});

describe('GET /v1/errors/series', () => {
  it('counts error.* rows per bucket from from, every bucket present, zeros included', async () => {
    const at = (h: number, m: number) => new Date(Date.UTC(2026, 10, 2, h, m)).toISOString();
    clock = new Date(at(12, 0));
    await send(shopKey, [
      { message: 'a', runtime: 'server', occurredAt: at(9, 10) },
      { message: 'a', runtime: 'server', occurredAt: at(9, 50) },
      { kind: 'Other', message: 'b', runtime: 'server', occurredAt: at(11, 59) },
    ]);
    await send(shopStageKey, [{ message: 'a', runtime: 'server', occurredAt: at(9, 30) }]);
    await send(blogKey, [{ message: 'a', runtime: 'server', occurredAt: at(9, 30) }]);
    const url = `/v1/errors/series?site=shop&environment=production&from=${at(9, 0)}&to=${at(12, 0)}`;
    const res = await get(url);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      bucketMinutes: 60,
      buckets: [
        { start: at(9, 0), errors: 2 },
        { start: at(10, 0), errors: 0 },
        { start: at(11, 0), errors: 1 },
      ],
    });
    const other = (await (await get('/v1/errors?site=shop&search=b')).json()) as {
      items: { fingerprint: string; kind: string }[];
    };
    const fp = other.items.find((g) => g.kind === 'Other')?.fingerprint;
    const one = (await (await get(`${url}&fingerprint=${fp}`)).json()) as {
      buckets: { errors: number }[];
    };
    expect(one.buckets.map((b) => b.errors)).toEqual([0, 0, 1]);
    // The same error in the same hour from stage and from another site is
    // another group: a fingerprint's series counts only its own rows.
    const sameError = (await (await get('/v1/errors?site=shop&environment=production')).json()) as {
      items: { fingerprint: string; kind: string }[];
    };
    const aFp = sameError.items.find((g) => g.kind === 'Error')?.fingerprint;
    const own = (await (
      await get(`/v1/errors/series?site=shop&from=${at(9, 0)}&to=${at(12, 0)}&fingerprint=${aFp}`)
    ).json()) as { buckets: { errors: number }[] };
    expect(own.buckets.map((b) => b.errors)).toEqual([2, 0, 0]);
    const events = await t.query(
      "select data->>'fingerprint' as fp, site, environment from reporting_events order by site, environment",
    );
    expect(new Set(events.map((e) => e.fp)).size).toBe(4);
    const day = (await (
      await get(
        `/v1/errors/series?site=shop&from=${at(0, 0)}&to=2026-11-04T00:00:00.000Z&bucket=1440`,
      )
    ).json()) as { bucketMinutes: number; buckets: { errors: number }[] };
    expect(day.bucketMinutes).toBe(1440);
    expect(day.buckets.map((b) => b.errors)).toEqual([4, 0]);
  });

  it('refuses a bad bucket, a range over 31 days, to before from, and a missing time', async () => {
    const q = (rest: string) => get(`/v1/errors/series?site=shop&${rest}`);
    expect((await q('from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&bucket=20')).status).toBe(
      400,
    );
    expect((await q('from=2026-10-01T00:00:00Z&to=2026-11-02T00:00:00Z')).status).toBe(400);
    expect((await q('from=2026-10-02T00:00:00Z&to=2026-11-02T00:00:00Z')).status).toBe(200);
    expect((await q('from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z')).status).toBe(400);
    expect((await q('from=2026-11-02T00:00:00Z')).status).toBe(400);
    expect((await q('from=x&to=2026-11-02T00:00:00Z')).status).toBe(400);
  });
});

const rep = (over: Record<string, unknown> = {}) => ({
  kind: 'TypeError',
  message: 'cannot read x',
  runtime: 'server',
  ...over,
});
type Group = {
  kind: string;
  fingerprint: string;
  retries: number;
  contexts: { company: string[]; mcp: string[]; account: string[] };
};
const groups = async (query: string) => {
  const res = await get(`/v1/errors?${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Group[] }).items;
};

describe('error context ids', () => {
  it('stores context and retryOf raw in data beside person, no other keys', async () => {
    const ctx = { company: 'acme', mcp: 'mcp_1', account: 'acc:1.2' };
    expect(
      (await send(shopKey, [rep({ context: ctx, retryOf: 'req-1', person: 'u' })])).status,
    ).toBe(202);
    expect((await send(shopKey, [rep({ kind: 'Plain' })])).status).toBe(202);
    const rows = await t.query('select kind, data from reporting_events order by kind');
    const data = (kind: string) =>
      rows.find((r) => r.kind === kind)?.data as Record<string, unknown>;
    expect(data('error.type_error')).toMatchObject({
      contextCompany: 'acme',
      contextMcp: 'mcp_1',
      contextAccount: 'acc:1.2',
    });
    expect(data('error.type_error').context).toBeUndefined();
    expect(data('error.type_error').retryOf).toBe('req-1');
    expect(data('error.type_error').person).toMatch(/^[0-9a-f]{32}$/);
    expect(Object.keys(data('error.plain')).sort()).toEqual(['fingerprint', 'runtime']);
  });

  it('refuses an invalid context id, an extra key or a bad retryOf with invalid_request', async () => {
    const bad: Record<string, unknown>[] = [
      { context: { company: 'ann@example.com' } },
      { context: { company: 'has space' } },
      { context: { mcp: '' } },
      { context: { account: 'x'.repeat(129) } },
      { context: { company: 'ok', region: 'eu' } },
      { context: 'acme' },
      { retryOf: '' },
      { retryOf: 'r'.repeat(129) },
    ];
    for (const over of bad) {
      const res = await send(shopKey, [rep(over)]);
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'invalid_request' } });
    }
    expect((await t.query('select 1 from reporting_events')).length).toBe(0);
    const edge = await send(shopKey, [rep({ context: { company: 'x'.repeat(128) } })]);
    expect(edge.status).toBe(202);
  });

  it('lists contexts per group (sorted, deduped, at most 20 per key) and counts retries', async () => {
    await send(shopKey, [
      rep({ context: { company: 'zeta', mcp: 'm1' } }),
      rep({ context: { company: 'acme', mcp: 'm1' }, retryOf: 'r1' }),
      rep({ retryOf: 'r2' }),
      rep({ kind: 'Other' }),
    ]);
    const batch = Array.from({ length: 25 }, (_, i) =>
      rep({ kind: 'Many', context: { account: `acc-${String(i).padStart(2, '0')}` } }),
    );
    await send(shopKey, batch.slice(0, 20));
    await send(shopKey, batch.slice(20));
    const byKind = Object.fromEntries((await groups('site=shop')).map((g) => [g.kind, g]));
    expect(byKind.TypeError?.contexts).toEqual({
      company: ['acme', 'zeta'],
      mcp: ['m1'],
      account: [],
    });
    expect(byKind.TypeError?.retries).toBe(2);
    expect(byKind.Other).toMatchObject({
      retries: 0,
      contexts: { company: [], mcp: [], account: [] },
    });
    const many = byKind.Many?.contexts.account ?? [];
    expect(many).toHaveLength(20);
    expect(many[0]).toBe('acc-00');
    expect(many[19]).toBe('acc-19');
    const one = (await (
      await get(`/v1/errors/${byKind.TypeError?.fingerprint}?site=shop`)
    ).json()) as Group;
    expect(one.contexts.company).toEqual(['acme', 'zeta']);
    expect(one.retries).toBe(2);
  });

  it('filters the list to groups with an event carrying the id, all given ids together', async () => {
    await send(shopKey, [
      rep({ context: { company: 'acme', mcp: 'm1' } }),
      rep({ kind: 'B', context: { company: 'acme', mcp: 'm2' } }),
      rep({ kind: 'C', context: { company: 'globex', mcp: 'm1' } }),
      rep({ kind: 'D' }),
    ]);
    await send(blogKey, [rep({ kind: 'E', context: { company: 'acme' } })]);
    const kinds = async (q: string) => (await groups(`site=shop&${q}`)).map((g) => g.kind).sort();
    expect(await kinds('company=acme')).toEqual(['B', 'TypeError']);
    expect(await kinds('mcp=m1')).toEqual(['C', 'TypeError']);
    expect(await kinds('company=acme&mcp=m1')).toEqual(['TypeError']);
    expect(await kinds('company=nobody')).toEqual([]);
    expect(await kinds('')).toEqual(['B', 'C', 'D', 'TypeError']);
  });

  it('pages a filtered list with a cursor and keeps state and environment filters', async () => {
    clock = new Date('2026-11-02T12:00:00.000Z');
    for (const kind of ['A', 'B', 'C']) {
      await send(shopKey, [rep({ kind, context: { company: 'acme' } })]);
      clock = new Date(clock.getTime() + 60_000);
    }
    await send(shopStageKey, [rep({ kind: 'S', context: { company: 'acme' } })]);
    const first = (await (await get('/v1/errors?site=shop&company=acme&limit=2')).json()) as {
      items: Group[];
      next: string | null;
    };
    expect(first.items.map((g) => g.kind)).toEqual(['S', 'C']);
    const second = (await (
      await get(`/v1/errors?site=shop&company=acme&limit=2&after=${first.next}`)
    ).json()) as { items: Group[]; next: string | null };
    expect(second.items.map((g) => g.kind)).toEqual(['B', 'A']);
    expect(second.next).toBeNull();
    const prod = await groups('site=shop&company=acme&environment=production');
    expect(prod.map((g) => g.kind).sort()).toEqual(['A', 'B', 'C']);
    expect(await groups('site=shop&company=acme&state=resolved')).toEqual([]);
  });

  it('filters the detail (404 without the id) and the series', async () => {
    const at = (h: number, m: number) => new Date(Date.UTC(2026, 10, 2, h, m)).toISOString();
    await send(shopKey, [
      rep({ occurredAt: at(9, 10), context: { company: 'acme' } }),
      rep({ occurredAt: at(9, 20), context: { company: 'globex' } }),
      rep({ occurredAt: at(10, 20), context: { company: 'acme' } }),
    ]);
    const fp = (await groups('site=shop'))[0]?.fingerprint;
    expect((await get(`/v1/errors/${fp}?site=shop&company=acme`)).status).toBe(200);
    expect((await get(`/v1/errors/${fp}?site=shop&company=nobody`)).status).toBe(404);
    const series = async (q: string) =>
      (
        (await (
          await get(`/v1/errors/series?site=shop&from=${at(9, 0)}&to=${at(11, 0)}&${q}`)
        ).json()) as { buckets: { errors: number }[] }
      ).buckets.map((b) => b.errors);
    expect(await series('company=acme')).toEqual([1, 1]);
    expect(await series('company=globex')).toEqual([1, 0]);
    expect(await series('')).toEqual([2, 1]);
  });

  it('refuses a bad company, mcp or account on list, series and detail with 400', async () => {
    const range = 'from=2026-11-02T00:00:00Z&to=2026-11-02T01:00:00Z';
    const fp = '0123456789abcdef0123456789abcdef';
    for (const key of ['company', 'mcp', 'account']) {
      for (const value of ['a%40b.com', 'a%20b', 'x'.repeat(129)]) {
        const q = `${key}=${value}`;
        expect((await get(`/v1/errors?site=shop&${q}`)).status, q).toBe(400);
        expect((await get(`/v1/errors/series?site=shop&${range}&${q}`)).status, q).toBe(400);
        expect((await get(`/v1/errors/${fp}?site=shop&${q}`)).status, q).toBe(400);
      }
    }
    const res = await get('/v1/errors?site=shop&company=a%40b.com');
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });
});

describe('GET /v1/errors/by-context', () => {
  const at = (d: number, h: number) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
  const byUrl = (by: string, rest = '') =>
    `/v1/errors/by-context?site=shop&from=${at(1, 0)}&to=${at(3, 0)}&by=${by}${rest}`;

  it('counts errors and groups per id, most errors first, within the window and site', async () => {
    await send(shopKey, [
      rep({ occurredAt: at(2, 1), context: { company: 'acme', mcp: 'm1' } }),
      rep({ occurredAt: at(2, 2), context: { company: 'acme' } }),
      rep({ occurredAt: at(2, 3), kind: 'B', context: { company: 'acme' } }),
      rep({ occurredAt: at(2, 4), context: { company: 'globex' } }),
      rep({ occurredAt: at(2, 5), kind: 'B', context: { company: 'initech' } }),
      rep({ occurredAt: at(2, 6) }),
      rep({ occurredAt: at(2, 7), context: { company: 'late' } }),
    ]);
    await send(shopStageKey, [rep({ occurredAt: at(2, 5), context: { company: 'globex' } })]);
    await send(blogKey, [rep({ occurredAt: at(2, 5), context: { company: 'acme' } })]);
    clock = new Date(at(5, 0));
    await send(shopKey, [rep({ occurredAt: at(4, 1), context: { company: 'late' } })]);
    const res = await get(byUrl('company', '&environment=production'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([
      { id: 'acme', errors: 3, groups: 2 },
      { id: 'globex', errors: 1, groups: 1 },
      { id: 'initech', errors: 1, groups: 1 },
      { id: 'late', errors: 1, groups: 1 },
    ]);
    expect(await (await get(byUrl('mcp'))).json()).toEqual({
      items: [{ id: 'm1', errors: 1, groups: 1 }],
    });
    const all = (await (await get(byUrl('company'))).json()) as {
      items: { id: string; errors: number }[];
    };
    expect(all.items.find((i) => i.id === 'globex')?.errors).toBe(2);
    const narrow = await get(
      `/v1/errors/by-context?site=shop&from=${at(2, 4)}&to=${at(2, 6)}&by=company`,
    );
    expect(((await narrow.json()) as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([
      'globex',
      'initech',
    ]);
  });

  it('returns at most 100 ids', async () => {
    const reports = Array.from({ length: 105 }, (_, i) =>
      rep({ occurredAt: at(2, 1), context: { account: `a-${String(i).padStart(3, '0')}` } }),
    );
    for (let i = 0; i < reports.length; i += 20) await send(shopKey, reports.slice(i, i + 20));
    const body = (await (await get(byUrl('account'))).json()) as { items: { id: string }[] };
    expect(body.items).toHaveLength(100);
    expect(body.items[0]?.id).toBe('a-000');
  });

  it('refuses a bad by, a window over 31 days or reversed, a missing time, and a missing site', async () => {
    expect((await get(byUrl('person'))).status).toBe(400);
    expect(
      (await get(`/v1/errors/by-context?site=shop&from=${at(1, 0)}&to=${at(3, 0)}`)).status,
    ).toBe(400);
    const q = (rest: string) => get(`/v1/errors/by-context?site=shop&by=mcp&${rest}`);
    expect((await q('from=2026-10-01T00:00:00Z&to=2026-11-02T00:00:00Z')).status).toBe(400);
    expect((await q('from=2026-10-02T00:00:00Z&to=2026-11-02T00:00:00Z')).status).toBe(200);
    expect((await q('from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z')).status).toBe(400);
    expect((await q('from=2026-11-02T00:00:00Z')).status).toBe(400);
    expect((await get(`/v1/errors/by-context?from=${at(1, 0)}&to=${at(3, 0)}&by=mcp`)).status).toBe(
      400,
    );
  });

  it('needs the operator key, as the other reads do', async () => {
    expect((await get(byUrl('company'), 'wrong')).status).toBe(401);
    expect((await get(byUrl('company'), shopKey)).status).toBe(401);
  });
});

describe('routes and the stores', () => {
  it('answers 404 { error } for an unknown route or method', async () => {
    const res = await get('/v1/reportings');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Route not found' } });
    expect((await handle(new Request(`${BASE}/v1/errors`, { method: 'PUT' }))).status).toBe(404);
  });

  it('audit_events refuses update, delete and truncate', async () => {
    await expect(t.exec("update audit_events set site = 'x'")).rejects.toThrow(/append-only/);
    await expect(t.exec('delete from audit_events')).rejects.toThrow(/append-only/);
    await expect(t.exec('truncate audit_events')).rejects.toThrow(/append-only/);
  });

  it('applied core’s migrations before this package’s', async () => {
    const rows = await t.query(
      'select source, filename from _migrations_sources order by applied_at, filename',
    );
    const sources = rows.map((r) => r.source);
    expect(sources.lastIndexOf('reporting')).toBeLessThan(sources.indexOf('reporting-service'));
    expect(rows.filter((r) => r.source === 'reporting-service').map((r) => r.filename)).toEqual([
      '0001_site_keys.sql',
      '0002_audit_events.sql',
      '0003_alerts.sql',
      '0004_release_audit.sql',
      '0005_alerts_dropped.sql',
    ]);
  });
});
