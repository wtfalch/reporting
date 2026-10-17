import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createReporting } from '../index.js';
import { type TestDb, memoryLog, testDb } from '../test/db.js';
import { countRequestErrors, countRequests } from './count.js';

vi.mock('next/server', () => ({ after: () => {}, connection: async () => {} }));

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t.close();
});
afterEach(() => vi.unstubAllEnvs());

const NOW = new Date('2026-10-10T12:00:30Z');
let n = 0;
const fresh = () => {
  n += 1;
  const log = memoryLog();
  const site = `count-${n}`;
  const reporting = createReporting({ db: t.db, log, site, mode: 'test', now: () => NOW });
  return { reporting, log, site };
};
const req = (path: string) => ({ url: `http://app.test${path}` });
const errArgs = (path: string) =>
  [
    new Error('boom'),
    { path, method: 'GET', headers: {} },
    { routerKind: 'App Router', routePath: '/p', routeType: 'render' },
  ] as const;
const rows = (site: string) =>
  t.query(
    `select color, release, requests, errors from reporting_requests where site = '${site}' order by color`,
  );

describe('count every request', () => {
  it('counts a page request and a page that throws under the right color and release', async () => {
    vi.stubEnv('REPORTING_COLOR', 'green');
    vi.stubEnv('REPORTING_RELEASE', 'sha256:bb');
    const { reporting, site } = fresh();
    const proxy = countRequests(reporting, () => ({ status: 200 }));
    const onError = countRequestErrors(reporting);

    await proxy(req('/dashboard'));
    await proxy(req('/broken')); // the page throws after the proxy passed it
    await onError(...errArgs('/broken'));
    await reporting.flush();

    expect(await rows(site)).toEqual([
      { color: 'green', release: 'sha256:bb', requests: 2, errors: 1 },
    ]);
  });

  it('counts the proxy own status: a redirect is a request, a 500 is an error', async () => {
    vi.stubEnv('REPORTING_COLOR', 'blue');
    vi.stubEnv('REPORTING_RELEASE', 'sha256:cc');
    const { reporting, site } = fresh();
    const statuses = [307, 403, 500];
    const proxy = countRequests(reporting, () => ({ status: statuses.shift() ?? 0 }));
    for (const p of ['/a', '/b', '/c']) await proxy(req(p));
    await reporting.flush();
    expect(await rows(site)).toEqual([
      { color: 'blue', release: 'sha256:cc', requests: 3, errors: 1 },
    ]);
  });

  it('counts a proxy that throws as a 500 and rethrows', async () => {
    const { reporting, site } = fresh();
    const boom = new Error('gate down');
    const proxy = countRequests(reporting, () => {
      throw boom;
    });
    await expect(proxy(req('/x'))).rejects.toBe(boom);
    await reporting.flush();
    expect(await rows(site)).toEqual([{ color: '', release: '', requests: 1, errors: 1 }]);
  });

  it('counts a throwing proxy once: Next also reports it to onRequestError as routeType proxy', async () => {
    const { reporting, site } = fresh();
    const proxy = countRequests(reporting, () => {
      throw new Error('gate down');
    });
    const onError = countRequestErrors(reporting);
    const [error, request, context] = errArgs('/x');
    await expect(proxy(req('/x'))).rejects.toThrow('gate down');
    await onError(error, request, { ...context, routeType: 'proxy' });
    await reporting.flush();
    expect(await rows(site)).toEqual([{ color: '', release: '', requests: 1, errors: 1 }]);
  });

  it('does not count the health probe or the release-health read', async () => {
    const { reporting, site } = fresh();
    const proxy = countRequests(reporting, () => ({ status: 200 }));
    const onError = countRequestErrors(reporting);
    for (const p of ['/api/health', '/api/health?x=1', '/api/reporting/release-health?from=a'])
      await proxy(req(p));
    await onError(...errArgs('/api/health'));
    await onError(...errArgs('/api/reporting/release-health?from=a'));
    await proxy(req('/api/healthy'));
    await reporting.flush();
    expect(await rows(site)).toEqual([{ color: '', release: '', requests: 1, errors: 0 }]);
  });

  it('counts nothing on the Edge runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    const { reporting, site } = fresh();
    await countRequests(reporting, () => ({ status: 200 }))(req('/p'));
    await countRequestErrors(reporting)(...errArgs('/p'));
    await reporting.flush();
    expect(await rows(site)).toEqual([]);
  });

  it('never fails the request when counting throws, and logs it', async () => {
    const log = memoryLog();
    const down = () => {
      throw new Error('counter down');
    };
    const broken = { log, requests: { record: down, recordError: down } };
    const response = { status: 200 };
    await expect(countRequests(broken, () => response)(req('/p'))).resolves.toBe(response);
    expect(countRequestErrors(broken)(...errArgs('/p'))).toBeUndefined();
    expect(log.lines.map((l) => [l.level, l.msg])).toEqual([
      ['error', 'reporting: request count failed'],
      ['error', 'reporting: request error count failed'],
    ]);
  });

  it('still runs the handler it wraps', async () => {
    const { reporting } = fresh();
    const next = vi.fn();
    const args = errArgs('/p');
    await countRequestErrors(reporting, next)(...args);
    expect(next).toHaveBeenCalledWith(...args);
  });
});
