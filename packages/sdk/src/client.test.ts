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

  it('sends an event and treats 202 as sent', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ accepted: true }, { status: 202 }),
    );
    const client = createReportingClient({
      baseUrl: 'https://reportings.test',
      credential: () => 'token',
      fetch: fetcher,
    });
    await expect(
      client.sendEvent({ kind: 'billing.charge_failed', message: 'card declined' }),
    ).resolves.toEqual({ accepted: true });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://reportings.test/events');
    expect(init?.method).toBe('POST');
  });

  it('reads an events page with filters in the query string', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ items: [], next: null }));
    const client = createReportingClient({
      baseUrl: 'https://reportings.test',
      credential: () => 'token',
      fetch: fetcher,
    });
    await client.events.page({ limit: 10, level: 'error', after: { occurredAt: 'x', id: 5 } });
    const [url] = fetcher.mock.calls[0] ?? [];
    const search = new URL(String(url)).searchParams;
    expect(search.get('limit')).toBe('10');
    expect(search.get('level')).toBe('error');
    expect(search.get('afterOccurredAt')).toBe('x');
    expect(search.get('afterId')).toBe('5');
  });

  it('sends an error report', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ accepted: true }, { status: 202 }),
    );
    const client = createReportingClient({
      baseUrl: 'https://reportings.test',
      credential: () => 'token',
      fetch: fetcher,
    });
    await expect(client.sendError({ message: 'boom' })).resolves.toEqual({ accepted: true });
    const [url] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://reportings.test/errors');
  });

  it('reads an error group and sets its state', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { fingerprint: 'f1', state: 'open' } }))
      .mockResolvedValueOnce(Response.json({ error: { fingerprint: 'f1', state: 'resolved' } }));
    const client = createReportingClient({
      baseUrl: 'https://reportings.test',
      credential: () => 'token',
      fetch: fetcher,
    });
    await client.errors.get('f1');
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://reportings.test/errors/f1');
    await client.errors.setState('f1', 'resolved');
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe('PATCH');
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ state: 'resolved' }));
  });

  it('records a request outcome', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ accepted: true }, { status: 202 }),
    );
    const client = createReportingClient({
      baseUrl: 'https://reportings.test',
      credential: () => 'token',
      fetch: fetcher,
    });
    await client.recordRequest({ status: 500, durationMs: 1200 });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://reportings.test/requests');
  });

  it('reads and sets settings, including a tenant override', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ settings: { 'events.retention_days': 30 } }))
      .mockResolvedValueOnce(Response.json({ overrides: {} }))
      .mockResolvedValueOnce(Response.json({ overrides: { 'events.retention_days': 90 } }));
    const client = createReportingClient({
      baseUrl: 'https://reportings.test',
      credential: () => 'token',
      fetch: fetcher,
    });
    await expect(client.settings.get()).resolves.toEqual({
      settings: { 'events.retention_days': 30 },
    });
    await client.tenantSettings.get('t1');
    expect(String(fetcher.mock.calls[1]?.[0])).toBe('https://reportings.test/settings/tenants/t1');
    await client.tenantSettings.set('t1', 'events.retention_days', 90);
    expect(fetcher.mock.calls[2]?.[1]?.method).toBe('PUT');
    expect(fetcher.mock.calls[2]?.[1]?.body).toBe(
      JSON.stringify({ key: 'events.retention_days', days: 90 }),
    );
  });

  it('reads release health over an explicit range', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        colors: { blue: { requests: 1, errors: 0 }, green: { requests: 0, errors: 0 } },
        daily: { days: 7, requestsPerDay: 1, errorsPerDay: 0 },
        from: 'a',
        to: 'b',
      }),
    );
    const client = createReportingClient({
      baseUrl: 'https://reportings.test',
      credential: () => 'token',
      fetch: fetcher,
    });
    await client.releaseHealth('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z');
    const search = new URL(String(fetcher.mock.calls[0]?.[0])).searchParams;
    expect(search.get('from')).toBe('2026-01-01T00:00:00Z');
    expect(search.get('to')).toBe('2026-01-02T00:00:00Z');
  });
});
