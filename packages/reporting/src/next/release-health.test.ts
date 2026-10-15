import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createReporting } from '../index.js';
import { type TestDb, memoryLog, testDb } from '../test/db.js';
import { releaseHealthHandler, withRequestCount } from './release-health.js';

vi.mock('next/server', () => ({ after: () => {}, connection: async () => {} }));

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t.close();
});
afterEach(() => vi.unstubAllEnvs());

const T0 = Date.parse('2026-10-10T12:00:00Z');
let clock = T0;
const reporting = () =>
  createReporting({
    db: t.db,
    log: memoryLog(),
    site: 'health',
    mode: 'test',
    now: () => new Date(clock),
  });

const get = (path: string, token?: string) =>
  new Request(`http://app.test${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
const range = `from=${encodeURIComponent('2026-10-10T11:00:00Z')}&to=${encodeURIComponent('2026-10-10T13:00:00Z')}`;

describe('tags and counter', () => {
  it('stamps release and color on events, analytics and errors, and null for a bad color', async () => {
    vi.stubEnv('REPORTING_RELEASE', 'sha256:aa');
    vi.stubEnv('REPORTING_COLOR', 'green');
    const r = reporting();
    r.event({ kind: 'tag.one', message: 'm' });
    await r.analytics.track({ name: 'tag_view', path: '/' });
    r.captureError(new TypeError('tagged boom'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await r.flush();
    const ev = await t.query(`select release, color from reporting_events where kind = 'tag.one'`);
    expect(ev).toEqual([{ release: 'sha256:aa', color: 'green' }]);
    const an = await t.query(
      `select release, color from reporting_analytics where name = 'tag_view'`,
    );
    expect(an).toEqual([{ release: 'sha256:aa', color: 'green' }]);
    const er = await t.query(
      `select release, color from reporting_errors where message = 'tagged boom'`,
    );
    expect(er).toEqual([{ release: 'sha256:aa', color: 'green' }]);

    vi.stubEnv('REPORTING_COLOR', 'purple');
    r.event({ kind: 'tag.two', message: 'm' });
    await r.flush();
    const bad = await t.query(`select color from reporting_events where kind = 'tag.two'`);
    expect(bad).toEqual([{ color: null }]);
  });

  it('writes one row per minute bucket and adds to it on the next flush', async () => {
    vi.stubEnv('REPORTING_COLOR', 'blue');
    vi.stubEnv('REPORTING_RELEASE', 'sha256:bb');
    clock = Date.parse('2026-01-01T00:00:10Z');
    const r = reporting();
    for (const s of [200, 404, 500, 503]) r.requests.record(s);
    await r.flush();
    r.requests.record(502);
    clock = Date.parse('2026-01-01T00:00:50Z');
    r.requests.record(200);
    await r.flush();
    const rows = await t.query(
      `select requests::int as requests, errors::int as errors, color, release from reporting_requests where bucket = '2026-01-01T00:00:00Z'`,
    );
    expect(rows).toEqual([{ requests: 6, errors: 3, color: 'blue', release: 'sha256:bb' }]);
  });
});

describe('releaseHealthHandler', () => {
  const handler = (...token: [] | [string | undefined]) =>
    releaseHealthHandler({
      db: t.db,
      reporting: reporting(),
      token: () => (token.length ? token[0] : 'secret'),
    });

  it('returns separate, exact counts per color and the 7-day per-day average', async () => {
    const r = reporting();
    const record = async (color: string, at: string, statuses: number[]) => {
      vi.stubEnv('REPORTING_COLOR', color);
      vi.stubEnv('REPORTING_RELEASE', `sha256:${color}`);
      clock = Date.parse(at);
      for (const s of statuses) r.requests.record(s);
      await r.flush();
    };
    // In the range: blue 4 requests (1 error), green 3 requests (2 errors), two minutes each.
    await record('blue', '2026-10-10T11:30:00Z', [200, 200, 500]);
    await record('blue', '2026-10-10T11:31:00Z', [200]);
    await record('green', '2026-10-10T12:00:00Z', [200, 503]);
    await record('green', '2026-10-10T12:59:00Z', [500]);
    // Outside the range, inside the 7 days before it: 14 requests, 7 errors, any color.
    await record('blue', '2026-10-03T11:00:00Z', [500, 500, 500, 200, 200, 200, 200]);
    await record('green', '2026-10-09T10:59:00Z', [500, 500, 500, 500, 200, 200, 200]);
    // Outside both: before the baseline, and at `to` (exclusive).
    await record('blue', '2026-10-03T10:59:00Z', [500, 500]);
    await record('blue', '2026-10-10T13:00:00Z', [500]);

    const res = await handler()(get(`/api/reporting/release-health?${range}`, 'secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      colors: { blue: { requests: 4, errors: 1 }, green: { requests: 3, errors: 2 } },
      daily: { days: 7, requestsPerDay: 14 / 7, errorsPerDay: 7 / 7 },
      from: '2026-10-10T11:00:00.000Z',
      to: '2026-10-10T13:00:00.000Z',
    });
  });

  it('refuses a missing token, a wrong token and a wrong scheme with 401', async () => {
    const url = `/api/reporting/release-health?${range}`;
    expect((await handler()(get(url))).status).toBe(401);
    expect((await handler()(get(url, 'wrong'))).status).toBe(401);
    expect((await handler()(get(url, 'secrets'))).status).toBe(401);
    const basic = new Request(`http://app.test${url}`, {
      headers: { authorization: 'Basic secret' },
    });
    expect((await handler()(basic)).status).toBe(401);
  });

  it('answers 503 when the token is unset, even to a request carrying one', async () => {
    const res = await handler(undefined)(get(`/x?${range}`, 'secret'));
    expect(res.status).toBe(503);
    expect((await handler('')(get(`/x?${range}`, ''))).status).toBe(503);
  });

  it.each([
    ['no params', ''],
    ['not a date', 'from=yesterday&to=2026-10-10T13:00:00Z'],
    ['from after to', 'from=2026-10-10T13:00:00Z&to=2026-10-10T11:00:00Z'],
    ['from equal to', 'from=2026-10-10T13:00:00Z&to=2026-10-10T13:00:00Z'],
    ['over 8 days', 'from=2026-10-01T00:00:00Z&to=2026-10-09T00:00:01Z'],
  ])('answers 400 for %s', async (_n, query) => {
    const res = await handler()(get(`/x?${query}`, 'secret'));
    expect(res.status).toBe(400);
  });

  it('accepts exactly 8 days', async () => {
    const res = await handler()(
      get('/x?from=2026-10-01T00:00:00Z&to=2026-10-09T00:00:00Z', 'secret'),
    );
    expect(res.status).toBe(200);
  });

  it('never returns event content', async () => {
    const r = reporting();
    r.event({ kind: 'leak.check', message: 'private-message-text', data: { k: 'private-data' } });
    r.captureError(new TypeError('private-error-text'));
    await r.flush();
    const res = await handler()(get(`/x?${range}`, 'secret'));
    const text = await res.text();
    expect(text).not.toMatch(/private|leak\.check/);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['colors', 'daily', 'from', 'to']);
  });
});

describe('withRequestCount', () => {
  it('counts a returned status and a throw as 500', async () => {
    const seen: number[] = [];
    const counting = { requests: { record: (s: number) => void seen.push(s) } };
    const ok = withRequestCount(counting, async () => new Response(null, { status: 502 }));
    expect((await ok()).status).toBe(502);
    const bad = withRequestCount(counting, async () => {
      throw new Error('x');
    });
    await expect(bad()).rejects.toThrow('x');
    expect(seen).toEqual([502, 500]);
  });
});
