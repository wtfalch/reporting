import { describe, expect, it, vi } from 'vitest';
import { createErrorReader } from './reader.js';
import { ReportingApiError } from './transport.js';
import type { ErrorGroup } from './types.js';

const GROUP: ErrorGroup = {
  fingerprint: '0123456789abcdef0123456789abcdef',
  site: 'shop',
  environment: 'production',
  kind: 'TypeError',
  message: 'boom',
  stack: null,
  runtime: 'server',
  release: null,
  occurrences: 3,
  firstSeenAt: '2026-11-02T10:00:00.000Z',
  lastSeenAt: '2026-11-02T11:00:00.000Z',
  requestId: null,
  state: 'open',
  resolvedAt: null,
  resolvedBy: null,
};

function reader(answer: () => Response | Promise<Response>) {
  const fetcher = vi.fn<typeof fetch>(async () => answer());
  const client = createErrorReader({
    url: 'https://reporting.test',
    operatorKey: 'op-key',
    fetch: fetcher,
  });
  const call = (i = 0) => {
    const [url, init] = fetcher.mock.calls[i] ?? [];
    return { url: new URL(String(url)), init };
  };
  return { client, fetcher, call };
}

describe('createErrorReader', () => {
  it('list sends the operator key and only the filters given', async () => {
    const r = reader(() => Response.json({ items: [GROUP], next: 'abc' }));
    await expect(
      r.client.list({
        site: 'shop',
        environment: 'stage',
        state: 'resolved',
        limit: 10,
        after: 'x/y',
      }),
    ).resolves.toEqual({ items: [GROUP], next: 'abc' });
    const { url, init } = r.call();
    expect(url.pathname).toBe('/v1/errors');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      site: 'shop',
      environment: 'stage',
      state: 'resolved',
      limit: '10',
      after: 'x/y',
    });
    expect(init?.method).toBe('GET');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer op-key' });
  });

  it('get reads one group by fingerprint and site', async () => {
    const r = reader(() => Response.json(GROUP));
    await expect(r.client.get({ site: 'shop', fingerprint: GROUP.fingerprint })).resolves.toEqual(
      GROUP,
    );
    expect(r.call().url.pathname).toBe(`/v1/errors/${GROUP.fingerprint}`);
    expect(r.call().url.searchParams.get('site')).toBe('shop');
  });

  it('setState posts { site, state, by } with by narrowed to class and id', async () => {
    const r = reader(() => Response.json({ ...GROUP, state: 'resolved' }));
    const by = { class: 'human' as const, id: 'user_1', email: 'x@example.com' };
    await r.client.setState({
      site: 'shop',
      fingerprint: GROUP.fingerprint,
      state: 'resolved',
      by,
    });
    const { url, init } = r.call();
    expect(url.pathname).toBe(`/v1/errors/${GROUP.fingerprint}/state`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      site: 'shop',
      state: 'resolved',
      by: { class: 'human', id: 'user_1' },
    });
  });

  it('series sends ISO times and the bucket', async () => {
    const r = reader(() => Response.json({ bucketMinutes: 1440, buckets: [] }));
    await r.client.series({
      site: 'shop',
      from: new Date('2026-11-01T00:00:00Z'),
      to: '2026-11-02T00:00:00.000Z',
      bucket: 1440,
      fingerprint: GROUP.fingerprint,
    });
    const { url } = r.call();
    expect(url.pathname).toBe('/v1/errors/series');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      site: 'shop',
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-02T00:00:00.000Z',
      bucket: '1440',
      fingerprint: GROUP.fingerprint,
    });
  });

  it('a failure is a ReportingApiError with the service error body’s code', async () => {
    const r = reader(() =>
      Response.json(
        { error: { code: 'not_found', message: 'No such error group' } },
        { status: 404 },
      ),
    );
    const failure = await r.client
      .get({ site: 'shop', fingerprint: GROUP.fingerprint })
      .catch((e) => e);
    expect(failure).toBeInstanceOf(ReportingApiError);
    expect(failure).toMatchObject({
      status: 404,
      code: 'not_found',
      message: 'No such error group',
    });
    const configured = reader(() =>
      Response.json({ error: { code: 'not_configured', message: 'x' } }, { status: 503 }),
    );
    await expect(configured.client.list({ site: 'shop' })).rejects.toMatchObject({
      code: 'not_configured',
    });
    const odd = reader(() => new Response('<html>', { status: 502 }));
    await expect(odd.client.list({ site: 'shop' })).rejects.toMatchObject({
      status: 502,
      code: 'unavailable',
    });
  });

  it('a lost connection or a timeout is unavailable with status 0', async () => {
    const lost = reader(() => {
      throw new TypeError('fetch failed');
    });
    await expect(lost.client.list({ site: 'shop' })).rejects.toMatchObject({
      status: 0,
      code: 'unavailable',
    });
    const slow = createErrorReader({
      url: 'https://reporting.test',
      operatorKey: 'k',
      timeoutMs: 20,
      fetch: (_u, init) =>
        new Promise((_r, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await expect(slow.list({ site: 'shop' })).rejects.toMatchObject({
      status: 0,
      code: 'unavailable',
      message: 'The request timed out',
    });
  });

  it('a response that stalls after its headers still times out', async () => {
    const stalling = createErrorReader({
      url: 'https://reporting.test',
      operatorKey: 'k',
      timeoutMs: 20,
      // Headers arrive at once; the body stream never closes.
      fetch: async () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
    });
    await expect(stalling.list({ site: 'shop' })).rejects.toMatchObject({
      status: 0,
      code: 'unavailable',
      message: 'The request timed out',
    });
  });

  it('get and setState refuse a fingerprint that is not 32 lower-case hex characters, before any request', async () => {
    const r = reader(() => Response.json(GROUP));
    await expect(r.client.get({ site: 'shop', fingerprint: '..' })).rejects.toMatchObject({
      status: 0,
      code: 'invalid_request',
    });
    await expect(
      r.client.setState({
        site: 'shop',
        fingerprint: '.',
        state: 'open',
        by: { class: 'human', id: 'u1' },
      }),
    ).rejects.toMatchObject({ status: 0, code: 'invalid_request' });
    expect(r.fetcher).not.toHaveBeenCalled();
  });
});
