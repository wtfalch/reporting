import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { countSignIn, createReporting } from '../index.js';
import { type TestDb, memoryLog, testDb } from '../test/db.js';
import { countRequests } from './count.js';
import { releaseSeriesHandler } from './release-series.js';

vi.mock('next/server', () => ({ after: () => {}, connection: async () => {} }));

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t.close();
});
afterEach(() => vi.unstubAllEnvs());

let clock = Date.parse('2026-10-10T12:00:00Z');
let n = 0;
const fresh = () => {
  n += 1;
  const site = `series-${n}`;
  const log = memoryLog();
  const reporting = createReporting({
    db: t.db,
    log,
    site,
    mode: 'test',
    now: () => new Date(clock),
  });
  return { reporting, site, log };
};
const at = (iso: string) => {
  clock = Date.parse(iso);
};
const get = (query: string, token?: string) =>
  new Request(`http://app.test/api/reporting/release-series?${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
const q = (from: string, to: string, bucket?: number | string) =>
  `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${bucket === undefined ? '' : `&bucket=${bucket}`}`;
const zeros = {
  requests: 0,
  errors: 0,
  slow: 0,
  durationMsSum: 0,
  signIns: 0,
  signInFailures: 0,
};

describe('duration, slow and sign-ins are counted per color', () => {
  it('records the duration sum and the slow count, and 1000 ms is not slow', async () => {
    vi.stubEnv('REPORTING_COLOR', 'green');
    vi.stubEnv('REPORTING_RELEASE', 'sha256:cc');
    const { reporting, site } = fresh();
    at('2026-10-10T12:00:10Z');
    reporting.requests.record(200, 120.4);
    reporting.requests.record(500, 1000); // exactly 1 s: not slow
    reporting.requests.record(200, 1001); // slow
    reporting.requests.record(200, 2500.6); // slow, rounds to 2501
    reporting.requests.record(200); // not timed: a request, no duration
    await reporting.flush();
    const rows = await t.query(
      `select color, requests::int as requests, errors::int as errors, duration_ms_sum::int as ms, slow::int as slow, sign_ins::int as sign_ins from reporting_requests where site = '${site}'`,
    );
    expect(rows).toEqual([
      {
        color: 'green',
        requests: 5,
        errors: 1,
        ms: 120 + 1000 + 1001 + 2501,
        slow: 2,
        sign_ins: 0,
      },
    ]);
  });

  it('keeps blue and green apart', async () => {
    const { reporting, site } = fresh();
    at('2026-10-10T12:00:10Z');
    vi.stubEnv('REPORTING_COLOR', 'blue');
    reporting.requests.record(200, 2000);
    await reporting.flush();
    vi.stubEnv('REPORTING_COLOR', 'green');
    reporting.requests.record(200, 10);
    await reporting.flush();
    const rows = await t.query(
      `select color, duration_ms_sum::int as ms, slow::int as slow from reporting_requests where site = '${site}' order by color`,
    );
    expect(rows).toEqual([
      { color: 'blue', ms: 2000, slow: 1 },
      { color: 'green', ms: 10, slow: 0 },
    ]);
  });

  it('countSignIn adds to sign_ins or sign_in_failures in the current minute and color, with no request', async () => {
    vi.stubEnv('REPORTING_COLOR', 'blue');
    const { reporting, site } = fresh();
    at('2026-10-10T12:00:10Z');
    countSignIn(true);
    countSignIn(true);
    countSignIn(false);
    at('2026-10-10T12:01:10Z');
    countSignIn(false);
    await reporting.flush();
    vi.stubEnv('REPORTING_COLOR', 'green');
    countSignIn(true);
    await reporting.flush();
    const rows = await t.query(
      `select bucket, color, requests::int as requests, sign_ins::int as ins, sign_in_failures::int as fails from reporting_requests where site = '${site}' order by bucket, color`,
    );
    expect(rows.map((r) => ({ ...r, bucket: new Date(r.bucket as string).toISOString() }))).toEqual(
      [
        { bucket: '2026-10-10T12:00:00.000Z', color: 'blue', requests: 0, ins: 2, fails: 1 },
        { bucket: '2026-10-10T12:01:00.000Z', color: 'blue', requests: 0, ins: 0, fails: 1 },
        { bucket: '2026-10-10T12:01:00.000Z', color: 'green', requests: 0, ins: 1, fails: 0 },
      ],
    );
  });

  it('countRequests times the handler', async () => {
    vi.stubEnv('REPORTING_COLOR', 'blue');
    const { reporting, site } = fresh();
    at('2026-10-10T12:00:10Z');
    const proxy = countRequests(reporting, async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { status: 200 };
    });
    await proxy({ url: 'http://app.test/x' });
    await reporting.flush();
    const [row] = await t.query(
      `select requests::int as requests, duration_ms_sum::int as ms from reporting_requests where site = '${site}'`,
    );
    expect(row?.requests).toBe(1);
    expect(Number(row?.ms)).toBeGreaterThanOrEqual(25);
    expect(Number(row?.ms)).toBeLessThan(1000);
  });
});

describe('release series', () => {
  const TOKEN = 'series-token';

  async function seed() {
    const { reporting, site, log } = fresh();
    const handler = releaseSeriesHandler({ db: t.db, reporting, token: () => TOKEN });
    // blue: minutes 12:05 and 12:15 (bucket 12:00-12:20) and 12:25 (bucket 12:20-12:40)
    vi.stubEnv('REPORTING_COLOR', 'blue');
    at('2026-10-10T12:05:00Z');
    reporting.requests.record(200, 100);
    reporting.requests.record(500, 1500);
    countSignIn(true);
    at('2026-10-10T12:15:30Z');
    reporting.requests.record(200, 50);
    countSignIn(false);
    at('2026-10-10T12:25:00Z');
    reporting.requests.record(200, 10);
    await reporting.flush();
    // green: 12:19 (bucket 12:00-12:20) and 12:40 (bucket 12:40-13:00)
    vi.stubEnv('REPORTING_COLOR', 'green');
    at('2026-10-10T12:19:59Z');
    reporting.requests.record(200, 30);
    at('2026-10-10T12:40:00Z');
    reporting.requests.record(503, 2000);
    await reporting.flush();
    // An uncolored row and a row of another site never appear.
    vi.stubEnv('REPORTING_COLOR', '');
    at('2026-10-10T12:06:00Z');
    reporting.requests.record(200, 5);
    await reporting.flush();
    return { handler, site, log, reporting };
  }

  it('sums minute rows into 20-minute buckets per color, with empty buckets present as zeros', async () => {
    const { handler } = await seed();
    const res = await handler(get(q('2026-10-10T12:00:00Z', '2026-10-10T13:00:00Z', 20), TOKEN));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      bucketMinutes: 20,
      buckets: [
        {
          start: '2026-10-10T12:00:00.000Z',
          colors: {
            blue: {
              requests: 3,
              errors: 1,
              slow: 1,
              durationMsSum: 1650,
              signIns: 1,
              signInFailures: 1,
            },
            green: { ...zeros, requests: 1, durationMsSum: 30 },
          },
        },
        {
          start: '2026-10-10T12:20:00.000Z',
          colors: { blue: { ...zeros, requests: 1, durationMsSum: 10 }, green: zeros },
        },
        {
          start: '2026-10-10T12:40:00.000Z',
          colors: {
            blue: zeros,
            green: { ...zeros, requests: 1, errors: 1, slow: 1, durationMsSum: 2000 },
          },
        },
      ],
    });
  });

  it('starts buckets at from, uses bucket 10 and 60, and defaults to 20', async () => {
    const { handler } = await seed();
    const ten = await (
      await handler(get(q('2026-10-10T12:10:00Z', '2026-10-10T12:30:00Z', 10), TOKEN))
    ).json();
    expect(ten.bucketMinutes).toBe(10);
    expect(ten.buckets.map((b: { start: string }) => b.start)).toEqual([
      '2026-10-10T12:10:00.000Z',
      '2026-10-10T12:20:00.000Z',
    ]);
    expect(ten.buckets[0].colors.blue.requests).toBe(1); // 12:15
    expect(ten.buckets[0].colors.green.requests).toBe(1); // 12:19
    expect(ten.buckets[1].colors.blue.requests).toBe(1); // 12:25

    const hour = await (
      await handler(get(q('2026-10-10T12:00:00Z', '2026-10-10T13:00:00Z', 60), TOKEN))
    ).json();
    expect(hour.buckets).toHaveLength(1);
    expect(hour.buckets[0].colors.blue.requests).toBe(4);

    const dflt = await (
      await handler(get(q('2026-10-10T12:00:00Z', '2026-10-10T13:00:00Z'), TOKEN))
    ).json();
    expect(dflt.bucketMinutes).toBe(20);
  });

  it('leaves out rows before from and from to on, and does not count the read itself', async () => {
    const { handler, reporting } = await seed();
    const body = await (
      await handler(get(q('2026-10-10T12:20:00Z', '2026-10-10T12:40:00Z', 20), TOKEN))
    ).json();
    expect(body.buckets).toHaveLength(1);
    expect(body.buckets[0].colors.blue.requests).toBe(1);
    expect(body.buckets[0].colors.green.requests).toBe(0);

    // The proxy wrapper does not count the series path.
    const proxy = countRequests(reporting, () => ({ status: 200 }));
    vi.stubEnv('REPORTING_COLOR', 'blue');
    at('2026-10-10T14:00:00Z');
    await proxy({ url: 'http://app.test/api/reporting/release-series?from=a' });
    await proxy({ url: 'http://app.test/api/reporting/release-health' });
    await reporting.flush();
    const after = await (
      await handler(get(q('2026-10-10T14:00:00Z', '2026-10-10T14:20:00Z', 20), TOKEN))
    ).json();
    expect(after.buckets[0].colors.blue.requests).toBe(0);
  });

  it('refuses without the token: 401 missing or wrong, 503 unset', async () => {
    const { handler } = await seed();
    const range = q('2026-10-10T12:00:00Z', '2026-10-10T13:00:00Z', 20);
    expect((await handler(get(range))).status).toBe(401);
    expect((await handler(get(range, 'wrong-token'))).status).toBe(401);
    const unset = releaseSeriesHandler({
      db: t.db,
      reporting: fresh().reporting,
      token: () => undefined,
    });
    expect((await unset(get(range, TOKEN))).status).toBe(503);
  });

  it('answers 400 to a bad bucket, a span over 8 days, a reversed range and non-ISO times', async () => {
    const { handler } = await seed();
    const from = '2026-10-01T00:00:00Z';
    const bad = [
      q(from, '2026-10-01T06:00:00Z', 15),
      q(from, '2026-10-01T06:00:00Z', 'abc'),
      q(from, '2026-10-01T06:00:00Z', 0),
      q(from, '2026-10-09T00:00:01Z', 20), // 8 days and one second
      q('2026-10-01T06:00:00Z', from, 20),
      q(from, from, 20),
      'from=yesterday&to=today&bucket=20',
      'bucket=20',
    ];
    for (const query of bad) {
      expect((await handler(get(query, TOKEN))).status, query).toBe(400);
    }
    // Exactly 8 days is allowed: 1152 ten-minute buckets.
    const ok = await handler(get(q(from, '2026-10-09T00:00:00Z', 10), TOKEN));
    expect(ok.status).toBe(200);
    expect((await ok.json()).buckets).toHaveLength(1152);
  });

  it('only reads its own site', async () => {
    await seed();
    const other = fresh();
    const otherHandler = releaseSeriesHandler({
      db: t.db,
      reporting: other.reporting,
      token: () => TOKEN,
    });
    const body = await (
      await otherHandler(get(q('2026-10-10T12:00:00Z', '2026-10-10T13:00:00Z', 60), TOKEN))
    ).json();
    expect(body.buckets[0].colors.blue).toEqual(zeros);
  });
});
