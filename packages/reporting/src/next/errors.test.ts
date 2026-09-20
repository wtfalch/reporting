import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ headers: async () => ({ get: () => null }) }));
vi.mock('next/navigation', () => ({ unstable_rethrow: () => {} }));
vi.mock('next/server', () => ({ after: () => {}, connection: async () => {} }));

import { createFakeReporting } from '../fake/index.js';
import { clientErrorHandler, errorHandler } from './index.js';

const HOST = 'app.example.test';

function post(body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(`https://${HOST}/api/reporting/errors`, {
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

describe('errorHandler', () => {
  const ORIGINAL_RUNTIME = process.env.NEXT_RUNTIME;
  afterEach(() => {
    if (ORIGINAL_RUNTIME === undefined) {
      // biome-ignore lint/performance/noDelete: deleting an env var, not a plain object property.
      delete process.env.NEXT_RUNTIME;
    } else {
      process.env.NEXT_RUNTIME = ORIGINAL_RUNTIME;
    }
  });

  it('captures with runtime server when NEXT_RUNTIME is unset', async () => {
    // biome-ignore lint/performance/noDelete: deleting an env var, not a plain object property.
    delete process.env.NEXT_RUNTIME;
    const fake = createFakeReporting();
    const handler = errorHandler(fake);
    await handler(new Error('boom'), { path: '/x', method: 'GET', headers: {} }, {
      routerKind: 'App Router',
      routePath: '/x',
      routeType: 'render',
    } as never);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]?.data).toMatchObject({ runtime: 'server' });
  });

  it('captures with runtime edge when NEXT_RUNTIME says so', async () => {
    process.env.NEXT_RUNTIME = 'edge';
    const fake = createFakeReporting();
    const handler = errorHandler(fake);
    await handler(new Error('boom'), { path: '/x', method: 'GET', headers: {} }, {} as never);
    expect(fake.rows[0]?.data).toMatchObject({ runtime: 'edge' });
  });

  it('takes the requestId from cf-ray, else a fresh uuid, the same way requestContext() does', async () => {
    const fake = createFakeReporting();
    const handler = errorHandler(fake);
    await handler(
      new Error('boom'),
      { path: '/x', method: 'GET', headers: { 'cf-ray': '8f3e2c1a9b7d4e5f-ARN' } },
      {} as never,
    );
    expect(fake.rows[0]?.requestId).toBe('8f3e2c1a9b7d4e5f-ARN');
    await handler(new Error('boom2'), { path: '/x', method: 'GET', headers: {} }, {} as never);
    expect(fake.rows[1]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('never throws when captureError itself throws', async () => {
    const fake = createFakeReporting();
    const broken = {
      ...fake,
      captureError: () => {
        throw new Error('captureError is broken');
      },
    };
    const handler = errorHandler(broken);
    expect(() =>
      handler(new Error('boom'), { path: '/x', method: 'GET', headers: {} }, {} as never),
    ).not.toThrow();
  });
});

describe('clientErrorHandler', () => {
  function setup(over: Partial<Parameters<typeof clientErrorHandler>[0]> = {}) {
    const reporting = createFakeReporting({ site: 'app' });
    const handle = clientErrorHandler({ reporting, ...over });
    return { reporting, handle };
  }

  const validBody = {
    site: 'app',
    errors: [{ kind: 'TypeError', message: 'x is not a function', stack: 'TypeError: x' }],
  };

  it('stops capturing once the per-address rate is spent, and still 204s', async () => {
    const { reporting, handle } = setup({ ratePerMinute: 3 });
    const ip = { 'cf-connecting-ip': '203.0.113.9' };
    for (let i = 0; i < 10; i += 1) {
      const res = await handle(
        post({ site: 'app', errors: [{ kind: 'E', message: `m${i}` }] }, ip),
      );
      // Always 204: an ingest route that answers differently when it is
      // limiting tells a flooder exactly when to back off and try again.
      expect(res.status).toBe(204);
    }
    // Three captured, seven refused. Without a limiter this is 10 — an
    // unauthenticated write into a table that never prunes an open row.
    expect(reporting.rows).toHaveLength(3);
  });

  it('charges the batch its real size, so one big batch cannot beat the cap', async () => {
    const { reporting, handle } = setup({ ratePerMinute: 5 });
    const ip = { 'cf-connecting-ip': '203.0.113.10' };
    const many = {
      site: 'app',
      errors: Array.from({ length: 10 }, (_, i) => ({ kind: 'E', message: `m${i}` })),
    };
    // Ten entries, capped to BATCH_MAX=10, costs 10 against a budget of 5.
    expect((await handle(post(many, ip))).status).toBe(204);
    expect(reporting.rows).toHaveLength(0);
  });

  it('limits one address without touching another', async () => {
    const { reporting, handle } = setup({ ratePerMinute: 1 });
    const body = { site: 'app', errors: [{ kind: 'E', message: 'm' }] };
    await handle(post(body, { 'cf-connecting-ip': '203.0.113.1' }));
    await handle(post(body, { 'cf-connecting-ip': '203.0.113.1' }));
    await handle(post(body, { 'cf-connecting-ip': '203.0.113.2' }));
    // One each from two addresses; the first address's second try is refused.
    expect(reporting.rows).toHaveLength(2);
  });

  it('204s and captures a valid batch, with runtime browser', async () => {
    const { reporting, handle } = setup();
    const res = await handle(post(validBody));
    expect(res.status).toBe(204);
    expect(reporting.rows).toHaveLength(1);
    expect(reporting.rows[0]?.message).toBe('x is not a function');
    expect(reporting.rows[0]?.data).toMatchObject({ runtime: 'browser' });
  });

  it('204s and drops an oversized body without capturing', async () => {
    const { reporting, handle } = setup();
    const big = { site: 'app', errors: [{ kind: 'TypeError', message: 'x'.repeat(20_000) }] };
    const res = await handle(post(big));
    expect(res.status).toBe(204);
    expect(reporting.rows).toHaveLength(0);
  });

  it('204s and drops a malformed body without capturing', async () => {
    const { reporting, handle } = setup();
    const res = await handle(post('{"site":"app"'));
    expect(res.status).toBe(204);
    expect(reporting.rows).toHaveLength(0);
  });

  it('204s and drops a disallowed origin without capturing', async () => {
    const { reporting, handle } = setup({ origins: ['https://allowed.example'] });
    const res = await handle(post(validBody, { origin: 'https://evil.example' }));
    expect(res.status).toBe(204);
    expect(reporting.rows).toHaveLength(0);
  });

  it('accepts an allowed foreign origin', async () => {
    const { reporting, handle } = setup({ origins: ['https://widget.example'] });
    const res = await handle(post(validBody, { origin: 'https://widget.example' }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://widget.example');
    expect(reporting.rows).toHaveLength(1);
  });

  it('ignores a client-supplied tenantId', async () => {
    const { reporting, handle } = setup();
    const body = {
      site: 'app',
      errors: [{ kind: 'TypeError', message: 'x', tenantId: 'forged' }],
    };
    const res = await handle(post(body));
    expect(res.status).toBe(204);
    expect(reporting.rows).toHaveLength(1);
    expect(reporting.rows[0]?.tenantId).toBeNull();
  });

  it('drops the 11th entry of an oversized batch', async () => {
    const { reporting, handle } = setup();
    const errors = Array.from({ length: 11 }, (_, i) => ({ kind: 'TypeError', message: `e${i}` }));
    const res = await handle(post({ site: 'app', errors }));
    expect(res.status).toBe(204);
    expect(reporting.rows).toHaveLength(10);
  });
});
