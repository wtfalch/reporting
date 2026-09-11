import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (k: string) => store.get(k.toLowerCase()) ?? null }),
}));
vi.mock('next/navigation', () => ({ unstable_rethrow: () => {} }));
vi.mock('next/server', () => ({ after: () => {}, connection: async () => {} }));

describe('requestContext', () => {
  beforeEach(() => store.clear());

  it('takes a well-formed cf-ray and a two-letter country', async () => {
    store.set('cf-ray', '8f3e2c1a9b7d4e5f-ARN');
    store.set('cf-ipcountry', 'NO');
    store.set('cf-connecting-ip', '203.0.113.7');
    const { requestContext } = await import('./index.js');
    const ctx = await requestContext();
    expect(ctx).toMatchObject({ id: '8f3e2c1a9b7d4e5f-ARN', country: 'NO', ip: '203.0.113.7' });
  });

  it.each([
    ['free text', 'hello-world'],
    ['a chosen audit id', 'forged; drop table'],
    ['128 bytes of anything', 'x'.repeat(128)],
    ['a lower-case colo', '8f3e2c1a9b7d4e5f-arn'],
  ])("replaces a cf-ray that is not Cloudflare's shape with a uuid: %s", async (_n, ray) => {
    store.set('cf-ray', ray);
    const { requestContext } = await import('./index.js');
    const ctx = await requestContext();
    expect(ctx.id).not.toBe(ray);
    expect(ctx.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('drops a country that is not two capital letters', async () => {
    store.set('cf-ipcountry', 'T1');
    const { requestContext } = await import('./index.js');
    expect((await requestContext()).country).toBeNull();
  });
});
