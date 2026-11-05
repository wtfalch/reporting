import type { Queryable } from '@wtfalch/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteStore } from '../../tests/pglite-store';
import { alertMailFromEnv } from './alert-mail.js';
import { DEVELOPMENT_SITE_KEY, DEVELOPMENT_TENANT_ID, developmentSiteKeys } from './composition.js';
import { createReportingHost } from './reporting-host.js';

const assertRuntimeRole = vi.hoisted(() => vi.fn());
vi.mock('@wtfalch/db/runtime-role', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wtfalch/db/runtime-role')>()),
  assertRuntimeRole,
}));

const afterRuns = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock('next/server', () => ({
  after: (fn: () => Promise<unknown>) => {
    afterRuns.push(fn());
  },
}));

beforeEach(() => {
  assertRuntimeRole.mockResolvedValue(undefined);
  afterRuns.length = 0;
});

describe('alertMailFromEnv', () => {
  it('needs MAIL_FROM and a way to send', () => {
    expect(alertMailFromEnv({})).toBeNull();
    expect(alertMailFromEnv({ LETTERMINT_API_TOKEN: 'lm_x' })).toBeNull();
    expect(alertMailFromEnv({ MAIL_FROM: 'Acme <no-reply@acme.example>' })).toBeNull();
    expect(
      alertMailFromEnv({ MAIL_FROM: 'Acme <no-reply@acme.example>', LETTERMINT_API_TOKEN: 'lm_x' })
        ?.from,
    ).toBe('Acme <no-reply@acme.example>');
  });

  it('prefers the stage sink over the token, and refuses a From with a line break', () => {
    const sink = alertMailFromEnv({
      MAIL_FROM: 'Stage <noreply@stage.invalid>',
      MAIL_SINK_URL: 'http://acme-stage-sink:8025',
      LETTERMINT_API_TOKEN: 'lm_x',
    });
    expect(sink).not.toBeNull();
    expect(
      alertMailFromEnv({ MAIL_FROM: 'a@acme.example\r\nBcc: x@y.z', LETTERMINT_API_TOKEN: 'lm_x' }),
    ).toBeNull();
    expect(
      alertMailFromEnv({ MAIL_FROM: 'a@acme.example', MAIL_SINK_URL: 'not a url' }),
    ).toBeNull();
  });
});

describe('the host ticks the error emails', () => {
  it('after an accepted batch and after each health answer, never before', async () => {
    const store = await pgliteStore();
    const tick = vi.fn(async () => ({ sent: 0, failed: 0 }));
    const host = createReportingHost({
      db: store.orm as never,
      database: { query: async () => [] } as unknown as Queryable,
      tenantId: DEVELOPMENT_TENANT_ID,
      siteKeys: developmentSiteKeys,
      alerts: { tick },
    });
    const refused = await host.handleV1(
      new Request('https://reporting.test/v1/errors', {
        method: 'POST',
        headers: { authorization: 'Bearer wrong' },
        body: JSON.stringify({ errors: [{ message: 'x', runtime: 'server' }] }),
      }),
    );
    expect(refused.status).toBe(401);
    expect(tick).not.toHaveBeenCalled();
    const accepted = await host.handleV1(
      new Request('https://reporting.test/v1/errors', {
        method: 'POST',
        headers: { authorization: `Bearer ${DEVELOPMENT_SITE_KEY}` },
        body: JSON.stringify({ errors: [{ message: 'x', runtime: 'server' }] }),
      }),
    );
    expect(accepted.status).toBe(202);
    await Promise.all(afterRuns);
    expect(tick).toHaveBeenCalledTimes(1);
    await host.handleHealth();
    await Promise.all(afterRuns);
    expect(tick).toHaveBeenCalledTimes(2);
  });
});
