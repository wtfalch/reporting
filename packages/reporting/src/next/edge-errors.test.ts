import { describe, expect, it, vi } from 'vitest';
import { createFakeReporting } from '../fake/index.js';
import { createEdgeErrorIngestCollector, edgeErrorHandler } from './edge-errors.js';

const SECRET = 'test-shared-secret';

describe('edgeErrorHandler', () => {
  function fakeFetch() {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    });
    return { fetchFn, calls };
  }

  it('POSTs a serialised report with the shared secret header', async () => {
    const { fetchFn, calls } = fakeFetch();
    const handler = edgeErrorHandler({
      endpoint: '/api/reporting/edge-errors',
      secret: SECRET,
      release: 'v1',
      fetch: fetchFn as unknown as typeof fetch,
    });
    await handler(new Error('boom'), { path: '/x', method: 'GET', headers: {} }, {} as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/reporting/edge-errors');
    const init = calls[0]?.init as { headers: Record<string, string>; body: string };
    expect(init.headers['x-reporting-edge-secret']).toBe(SECRET);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ kind: 'Error', message: 'boom', release: 'v1' });
    expect(typeof body.requestId).toBe('string');
  });

  it('takes the requestId from cf-ray, else a fresh uuid', async () => {
    const { fetchFn, calls } = fakeFetch();
    const handler = edgeErrorHandler({
      endpoint: '/api/reporting/edge-errors',
      secret: SECRET,
      fetch: fetchFn as unknown as typeof fetch,
    });
    await handler(
      new Error('boom'),
      { path: '/x', method: 'GET', headers: { 'cf-ray': '8f3e2c1a9b7d4e5f-ARN' } },
      {} as never,
    );
    await handler(new Error('boom2'), { path: '/x', method: 'GET', headers: {} }, {} as never);
    const bodies = calls.map((c) => JSON.parse((c.init as { body: string }).body));
    expect(bodies[0]?.requestId).toBe('8f3e2c1a9b7d4e5f-ARN');
    expect(bodies[1]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('never throws (and never rejects), even when fetch itself throws synchronously', async () => {
    const handler = edgeErrorHandler({
      endpoint: '/api/reporting/edge-errors',
      secret: SECRET,
      fetch: (() => {
        throw new Error('network is down');
      }) as unknown as typeof fetch,
    });
    await expect(
      handler(new Error('boom'), { path: '/x', method: 'GET', headers: {} }, {} as never),
    ).resolves.toBeUndefined();
  });

  it('never rejects when fetch rejects asynchronously', async () => {
    const handler = edgeErrorHandler({
      endpoint: '/api/reporting/edge-errors',
      secret: SECRET,
      fetch: (async () => {
        throw new Error('network is down');
      }) as unknown as typeof fetch,
    });
    await expect(
      handler(new Error('boom'), { path: '/x', method: 'GET', headers: {} }, {} as never),
    ).resolves.toBeUndefined();
  });

  it('gives up once the timeout elapses, rather than hanging Next open', async () => {
    const handler = edgeErrorHandler({
      endpoint: '/api/reporting/edge-errors',
      secret: SECRET,
      timeoutMs: 10,
      fetch: ((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }) as unknown as typeof fetch,
    });
    await expect(
      handler(new Error('boom'), { path: '/x', method: 'GET', headers: {} }, {} as never),
    ).resolves.toBeUndefined();
  });
});

describe('createEdgeErrorIngestCollector (edgeErrorIngestHandler)', () => {
  function post(body: unknown, headers: Record<string, string> = {}) {
    const text = JSON.stringify(body);
    return new Request('https://app.example.test/api/reporting/edge-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: text,
    });
  }

  const validBody = {
    kind: 'TypeError',
    message: 'x is not a function',
    stack: 'TypeError: x',
    release: 'v1',
    requestId: 'req-1',
  };

  it('captures a valid report with the right secret, runtime edge', async () => {
    const reporting = createFakeReporting({ site: 'app' });
    const collector = createEdgeErrorIngestCollector({ reporting, secret: SECRET });
    const res = await collector.handle(post(validBody, { 'x-reporting-edge-secret': SECRET }));
    expect(res.status).toBe(204);
    expect(reporting.rows).toHaveLength(1);
    expect(reporting.rows[0]?.message).toBe('x is not a function');
    expect(reporting.rows[0]?.data).toMatchObject({ runtime: 'edge' });
    expect(reporting.rows[0]?.requestId).toBe('req-1');
  });

  it('204s and drops the report when the secret is missing', async () => {
    const reporting = createFakeReporting({ site: 'app' });
    const collector = createEdgeErrorIngestCollector({ reporting, secret: SECRET });
    const res = await collector.handle(post(validBody));
    expect(res.status).toBe(204);
    expect(reporting.rows).toHaveLength(0);
  });

  it('204s and drops the report when the secret is wrong', async () => {
    const reporting = createFakeReporting({ site: 'app' });
    const collector = createEdgeErrorIngestCollector({ reporting, secret: SECRET });
    const res = await collector.handle(
      post(validBody, { 'x-reporting-edge-secret': 'wrong-secret' }),
    );
    expect(res.status).toBe(204);
    expect(reporting.rows).toHaveLength(0);
  });

  it('204s and drops the report when the secret is a different length (no throw from timingSafeEqual)', async () => {
    const reporting = createFakeReporting({ site: 'app' });
    const collector = createEdgeErrorIngestCollector({ reporting, secret: SECRET });
    const res = await collector.handle(post(validBody, { 'x-reporting-edge-secret': 'x' }));
    expect(res.status).toBe(204);
    expect(reporting.rows).toHaveLength(0);
  });

  it('204s and drops a malformed body', async () => {
    const reporting = createFakeReporting({ site: 'app' });
    const collector = createEdgeErrorIngestCollector({ reporting, secret: SECRET });
    const res = await collector.handle(
      new Request('https://app.example.test/api/reporting/edge-errors', {
        method: 'POST',
        headers: { 'x-reporting-edge-secret': SECRET, 'content-type': 'application/json' },
        body: '{"kind":',
      }),
    );
    expect(res.status).toBe(204);
    expect(reporting.rows).toHaveLength(0);
  });

  it('204s a non-POST request without capturing', async () => {
    const reporting = createFakeReporting({ site: 'app' });
    const collector = createEdgeErrorIngestCollector({ reporting, secret: SECRET });
    const res = await collector.handle(
      new Request('https://app.example.test/api/reporting/edge-errors', {
        method: 'GET',
        headers: { 'x-reporting-edge-secret': SECRET },
      }),
    );
    expect(res.status).toBe(204);
    expect(reporting.rows).toHaveLength(0);
  });
});
