import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequestCounter } from '../requests.js';
import { memoryLog, testDb, type TestDb } from '../test/db.js';
import { releaseHealthHandler } from './release-health.js';

vi.mock('next/server', () => ({ after: () => {}, connection: async () => {} }));

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t.close();
});
afterEach(() => vi.unstubAllEnvs());

const counter = (site: string, at: string, db: unknown = t.db) =>
  new RequestCounter({
    db: db as TestDb['db'],
    log: memoryLog(),
    site,
    now: () => new Date(at),
    flushEveryMs: 60_000,
  });

const record = async (site: string, color: string, at: string, statuses: number[]) => {
  vi.stubEnv('REPORTING_COLOR', color);
  vi.stubEnv('REPORTING_RELEASE', `sha256:${color}`);
  const c = counter(site, at);
  for (const s of statuses) c.record(s);
  await c.flush();
};

const call = (site: string, from: string, to: string) =>
  releaseHealthHandler({
    db: t.db,
    reporting: { site, log: memoryLog() } as never,
    token: () => 'secret',
  })(
    new Request(
      `http://app.test/x?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { headers: { authorization: 'Bearer secret' } },
    ),
  );

describe('refuter: release health boundaries', () => {
  it('counts only its own site, in the range and in the baseline', async () => {
    await record('site-a', 'blue', '2030-01-10T12:00:00Z', [200, 500]);
    await record('site-a', 'blue', '2030-01-09T12:00:00Z', [200, 200, 500, 500, 200, 200, 200]);
    await record('site-b', 'blue', '2030-01-10T12:00:00Z', [500, 500, 500]);
    await record('site-b', 'green', '2030-01-09T12:00:00Z', [200, 200, 200, 200, 200, 200, 200]);
    const body = await (await call('site-a', '2030-01-10T11:00:00Z', '2030-01-10T13:00:00Z')).json();
    expect(body.colors).toEqual({
      blue: { requests: 2, errors: 1 },
      green: { requests: 0, errors: 0 },
    });
    expect(body.daily).toEqual({ days: 7, requestsPerDay: 1, errorsPerDay: 2 / 7 });
  });

  it('counts status 499 as ok and 500 as an error', async () => {
    await record('edge-status', 'green', '2030-02-10T12:00:00Z', [499, 499, 500]);
    const body = await (
      await call('edge-status', '2030-02-10T11:00:00Z', '2030-02-10T13:00:00Z')
    ).json();
    expect(body.colors.green).toEqual({ requests: 3, errors: 1 });
  });

  it('includes a bucket at from in the range (not the baseline) and excludes one at to', async () => {
    await record('edge-range', 'blue', '2030-03-10T11:00:00Z', [200, 200]);
    await record('edge-range', 'blue', '2030-03-10T13:00:00Z', [200]);
    await record('edge-range', 'blue', '2030-03-03T11:00:00Z', [200, 200, 200, 200, 200, 200, 200]);
    await record('edge-range', 'blue', '2030-03-03T10:59:00Z', [200]);
    const body = await (
      await call('edge-range', '2030-03-10T11:00:00Z', '2030-03-10T13:00:00Z')
    ).json();
    expect(body.colors.blue).toEqual({ requests: 2, errors: 0 });
    expect(body.daily.requestsPerDay).toBe(1);
  });

  it('rejects a range of 8 days and 1 second but accepts 8 days', async () => {
    expect((await call('x', '2030-04-01T00:00:00Z', '2030-04-09T00:00:01Z')).status).toBe(400);
    expect((await call('x', '2030-04-01T00:00:00Z', '2030-04-09T00:00:00Z')).status).toBe(200);
  });

  it('returns zero for an empty window and sums two releases of one color', async () => {
    const empty = await (await call('nothing', '2030-05-10T11:00:00Z', '2030-05-10T12:00:00Z')).json();
    expect(empty.colors).toEqual({
      blue: { requests: 0, errors: 0 },
      green: { requests: 0, errors: 0 },
    });
    expect(empty.daily).toEqual({ days: 7, requestsPerDay: 0, errorsPerDay: 0 });
    vi.stubEnv('REPORTING_COLOR', 'blue');
    for (const rel of ['r1', 'r2']) {
      vi.stubEnv('REPORTING_RELEASE', rel);
      const c = counter('two-rel', '2030-05-10T11:30:00Z');
      c.record(200);
      c.record(500);
      await c.flush();
    }
    const two = await (await call('two-rel', '2030-05-10T11:00:00Z', '2030-05-10T12:00:00Z')).json();
    expect(two.colors.blue).toEqual({ requests: 4, errors: 2 });
  });

  it('refuses a bearer header with an empty token and a lowercase scheme', async () => {
    const h = releaseHealthHandler({
      db: t.db,
      reporting: { site: 'x', log: memoryLog() } as never,
      token: () => 'secret',
    });
    const q = 'from=2030-06-01T00:00:00Z&to=2030-06-01T01:00:00Z';
    for (const auth of ['Bearer ', 'Bearer', 'bearer secret', 'Bearer secret extra', 'secret']) {
      const res = await h(new Request(`http://a.test/x?${q}`, { headers: { authorization: auth } }));
      expect(res.status, auth).toBe(401);
    }
  });
});

describe('refuter: counter flush failure', () => {
  it('keeps counts from a failed flush and writes them once on the next', async () => {
    let fail = true;
    const db = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === 'insert' && fail) {
          return () => {
            throw new Error('db down');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    vi.stubEnv('REPORTING_COLOR', 'green');
    vi.stubEnv('REPORTING_RELEASE', 'sha256:flush');
    const c = counter('flush-fail', '2030-07-01T00:00:10Z', db);
    c.record(200);
    c.record(500);
    await c.flush();
    c.record(503);
    fail = false;
    await c.flush();
    await c.flush();
    const rows = await t.query(
      `select requests::int as requests, errors::int as errors from reporting_requests where site = 'flush-fail'`,
    );
    expect(rows).toEqual([{ requests: 3, errors: 2 }]);
  });

  it('does not double count when flushes overlap', async () => {
    vi.stubEnv('REPORTING_COLOR', 'blue');
    vi.stubEnv('REPORTING_RELEASE', 'sha256:overlap');
    const c = counter('flush-overlap', '2030-07-02T00:00:10Z');
    for (const s of [200, 200, 500]) c.record(s);
    await Promise.all([c.flush(), c.flush(), c.flush()]);
    const rows = await t.query(
      `select requests::int as requests, errors::int as errors from reporting_requests where site = 'flush-overlap'`,
    );
    expect(rows).toEqual([{ requests: 3, errors: 1 }]);
  });
});
