import { describe, expect, it, vi } from 'vitest';
import { ReportingApiError, createReportingClient } from './client.js';

describe('createReportingClient', () => {
  it('creates a reporting and returns the parsed body', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(
        { id: 'g1', organisationId: 'org1', name: 'Widget', createdAt: 'now' },
        { status: 201 },
      ),
    );
    const client = createReportingClient({
      baseUrl: 'https://reportings.test',
      credential: () => 'token',
      fetch: fetcher,
    });
    await expect(
      client.createReporting({ organisationId: 'org1', name: 'Widget' }),
    ).resolves.toEqual({
      id: 'g1',
      organisationId: 'org1',
      name: 'Widget',
      createdAt: 'now',
    });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://reportings.test/v1/reportings');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ organisationId: 'org1', name: 'Widget' }));
  });

  it('turns a 403 into a typed ReportingApiError, not a bare Error', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { code: 'forbidden', message: 'Access denied' } }, { status: 403 }),
    );
    const client = createReportingClient({
      baseUrl: 'https://reportings.test',
      credential: () => 'token',
      fetch: fetcher,
    });
    const failure = await client
      .createReporting({ organisationId: 'org1', name: 'Widget' })
      .catch((e) => e);
    expect(failure).toBeInstanceOf(ReportingApiError);
    expect(failure).toMatchObject({ status: 403, code: 'forbidden', message: 'Access denied' });
    expect(failure).not.toBeInstanceOf(TypeError);
  });

  it('sends the resolved credential in the Authorization header', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ reportings: [] }));
    const credential = vi
      .fn()
      .mockResolvedValueOnce('first-token')
      .mockResolvedValueOnce('rotated-token');
    const client = createReportingClient({
      baseUrl: 'https://reportings.test',
      credential,
      fetch: fetcher,
    });
    await client.listReportings('org1');
    await client.listReportings('org1');
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer first-token',
    });
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer rotated-token',
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      'https://reportings.test/v1/reportings?organisationId=org1',
    );
  });
});
