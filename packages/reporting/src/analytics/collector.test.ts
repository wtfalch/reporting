import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, memoryLog, testDb } from '../test/db.js';
import { createCollector } from './collector.js';

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.exec('delete from reporting_analytics');
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const HOST = 'app.example.test';
const event = (
  over: Partial<{ name: string; path: string; referrer: string; props: object; at: number }> = {},
) => ({
  name: 'page.view',
  at: Date.now(),
  path: '/org/11111111-1111-4111-8111-111111111111/invoices/42?x=1',
  props: {},
  ...over,
});

function post(body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(`https://${HOST}/api/reporting/collect`, {
    method: 'POST',
    headers: {
      host: HOST,
      'content-type': 'application/json',
      'content-length': String(text.length),
      ...headers,
    },
    body: text,
  });
}

function collector(over: Partial<Parameters<typeof createCollector>[0]> = {}) {
  const log = memoryLog();
  const c = createCollector({
    db: t.db,
    log,
    site: 'app',
    sites: { wtfalch: { origins: ['https://wtfalch.dev'] } },
    getUserId: async (req) =>
      req.headers.get('cookie')?.includes('session=ok') ? 'user_ada' : null,
    tenantFor: async (userId, pathname, route) =>
      userId === 'user_ada' && route.startsWith('/org/:id') && pathname.includes(TENANT)
        ? TENANT
        : null,
    ...over,
  });
  return { c, log };
}

const rows = () =>
  t.query(
    'select site, tenant_id, user_id, visitor_id, name, path, referrer_host, device, country, props from reporting_analytics order by id',
  );

describe('the collector', () => {
  it('records a same-origin beacon with identity from the session, a normalised path and derived fields only', async () => {
    const { c } = collector();
    const res = await c.handle(
      post(
        {
          site: 'app',
          visitorId: 'a1b2c3d4e5f6a7b8',
          events: [event({ referrer: 'https://Google.com/search?q=x', props: { plan: 'pro' } })],
        },
        {
          cookie: 'session=ok',
          'user-agent': 'Mozilla/5.0 (iPhone) Mobile',
          'cf-ipcountry': 'NO',
          origin: `https://${HOST}`,
        },
      ),
    );
    expect(res.status).toBe(204);
    expect(await rows()).toEqual([
      {
        site: 'app',
        tenant_id: TENANT,
        user_id: 'user_ada',
        visitor_id: 'a1b2c3d4e5f6a7b8',
        name: 'page.view',
        path: '/org/:id/invoices/:n',
        referrer_host: 'google.com',
        device: 'mobile',
        country: 'NO',
        props: { plan: 'pro' },
      },
    ]);
  });

  it('never takes a user id or a tenant from the body', async () => {
    const { c } = collector();
    await c.handle(post({ site: 'app', userId: 'forged', tenantId: TENANT, events: [event()] }));
    expect(await rows()).toEqual([]);
  });

  it('stores no tenant for an anonymous claim on an organisation path', async () => {
    const { c } = collector();
    await c.handle(post({ site: 'app', events: [event()] }));
    expect((await rows())[0]).toMatchObject({ tenant_id: null, user_id: null });
  });

  it('accepts an allowed foreign origin for its site, without ever reading the session, and answers CORS', async () => {
    let sessionRead = false;
    const { c } = collector({
      getUserId: async () => {
        sessionRead = true;
        return 'user_ada';
      },
    });
    const res = await c.handle(
      post(
        { site: 'wtfalch', events: [event({ path: '/blog/hello' })] },
        { origin: 'https://wtfalch.dev', cookie: 'session=ok' },
      ),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://wtfalch.dev');
    expect(sessionRead).toBe(false);
    expect((await rows())[0]).toMatchObject({
      site: 'wtfalch',
      user_id: null,
      tenant_id: null,
      path: '/blog/hello',
    });
  });

  it("drops, with 204 and no CORS header, an unlisted origin, a foreign origin claiming the collector's own site, and a same-origin beacon for another site", async () => {
    const { c } = collector();
    for (const [body, headers] of [
      [{ site: 'wtfalch', events: [event()] }, { origin: 'https://evil.example' }],
      [{ site: 'app', events: [event()] }, { origin: 'https://wtfalch.dev' }],
      [{ site: 'wtfalch', events: [event()] }, { origin: `https://${HOST}` }],
    ] as const) {
      const res = await c.handle(post(body, headers));
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(await rows()).toEqual([]);
  });

  it('drops junk: an oversize body, invalid JSON, a schema miss, a wrong method', async () => {
    const { c, log } = collector();
    expect((await c.handle(post('{"site":"app"'))).status).toBe(204);
    expect((await c.handle(post({ site: 'app', events: [] }))).status).toBe(204);
    expect(
      (await c.handle(post({ site: 'app', events: [event({ props: { token: 'x' } })] }))).status,
    ).toBe(204);
    const big = post({ site: 'app', events: [event({ props: { a: 'x'.repeat(20_000) } })] });
    expect((await c.handle(big)).status).toBe(204);
    expect(
      (
        await c.handle(
          new Request(`https://${HOST}/api/reporting/collect`, {
            method: 'GET',
            headers: { host: HOST },
          }),
        )
      ).status,
    ).toBe(204);
    expect(await rows()).toEqual([]);
    expect(log.lines.some((l) => l.msg === 'reporting: beacon refused')).toBe(true);
  });

  it('answers preflight for an allowed origin only', async () => {
    const { c } = collector();
    const ok = await c.handle(
      new Request(`https://${HOST}/x`, {
        method: 'OPTIONS',
        headers: { host: HOST, origin: 'https://wtfalch.dev' },
      }),
    );
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://wtfalch.dev');
    const no = await c.handle(
      new Request(`https://${HOST}/x`, {
        method: 'OPTIONS',
        headers: { host: HOST, origin: 'https://evil.example' },
      }),
    );
    expect(no.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rate-limits per visitor and per ip, generously', async () => {
    const { c } = collector({ ratePerMinute: 25 });
    const batch = {
      site: 'app',
      visitorId: 'a1b2c3d4e5f6a7b8',
      events: Array.from({ length: 20 }, () => event()),
    };
    await c.handle(post(batch, { 'cf-connecting-ip': '10.0.0.1' }));
    await c.handle(post(batch, { 'cf-connecting-ip': '10.0.0.1' }));
    expect((await rows()).length).toBe(20);
  });

  it('clamps the beacon clock and stores duration as a prop', async () => {
    const { c } = collector();
    await c.handle(
      post({
        site: 'app',
        events: [
          { name: 'page.leave', at: Date.now() - 3_600_000, path: '/', props: {}, duration: 12 },
        ],
      }),
    );
    const [row] = await t.query(
      'select props, extract(epoch from (received_at - occurred_at)) as skew from reporting_analytics',
    );
    expect(row?.props).toEqual({ duration: 12 });
    expect(Number(row?.skew)).toBeLessThanOrEqual(600);
  });

  it('records anonymously when the session callback is off or throws', async () => {
    const { c } = collector({ identifySignedIn: async () => false });
    await c.handle(post({ site: 'app', events: [event()] }, { cookie: 'session=ok' }));
    const { c: c2 } = collector({
      getUserId: async () => {
        throw new Error('boom');
      },
    });
    await c2.handle(post({ site: 'app', events: [event()] }, { cookie: 'session=ok' }));
    expect((await rows()).map((r) => r.user_id)).toEqual([null, null]);
  });
});
