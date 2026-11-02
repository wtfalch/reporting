import { tenantIdOf } from '@wtfalch/reporting-service';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteStore } from '../../tests/pglite-store';

// The routes call sharedHost(), which opens the store. Here the store is an
// in-memory PGlite with the real migrations, so the real service handler runs
// end to end; only the connection and the role check (PGlite has no roles)
// are replaced. The check itself is runtime-role-guard.test.ts's, on Postgres.
const held = vi.hoisted(() => ({
  store: undefined as undefined | Awaited<ReturnType<typeof pgliteStore>>,
  roleChecks: 0,
}));
vi.mock('./connection', () => ({ SCHEMA: 'reporting', openDatabase: () => held.store?.owner }));
vi.mock('@wtfalch/db/drizzle', () => ({ withDrizzle: () => ({ orm: held.store?.orm }) }));
vi.mock('@wtfalch/db/runtime-role', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wtfalch/db/runtime-role')>()),
  async assertRuntimeRole() {
    held.roleChecks++;
  },
}));

const OPERATOR_KEY = 'operator-key-for-the-test-0123456789';
const ORGANISATION = '314159265358979323';
const DATABASE_URL = 'postgres://reporting_rt:runtime-password-for-the-test@db.internal:5432/x';
const BASE = 'https://reporting.test';

type Routes = typeof import('../app/v1/[[...path]]/route');

function request(method: string, path: string, bearer?: string, body?: unknown): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (bearer !== undefined) headers.set('authorization', `Bearer ${bearer}`);
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Boots the way production does: a fresh module graph, the shipped
 * instrumentation, then the route module. */
async function boot(env: { operatorKey: string; organisation: string }): Promise<Routes> {
  vi.stubEnv('REPORTING_OPERATOR_KEY', env.operatorKey);
  vi.stubEnv('AUTH_ORGANIZATION_ID', env.organisation);
  vi.resetModules();
  const comp = await import('./composition.js');
  comp.resetProductionComposition();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    await (await import('../instrumentation')).register();
  } finally {
    warn.mockRestore();
  }
  return import('../app/v1/[[...path]]/route');
}

async function count(table: string): Promise<number> {
  const [row] = (await held.store?.rows(`select count(*)::int as n from ${table}`)) ?? [];
  return Number(row?.n);
}

beforeAll(async () => {
  held.store = await pgliteStore();
}, 60_000);

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.stubEnv('DATABASE_URL', DATABASE_URL);
  held.roleChecks = 0;
});

afterEach(() => vi.unstubAllEnvs());

describe('production host before instrumentation has run', () => {
  it('/api/health is 200 with a version and a passing database check; /v1 refuses', async () => {
    vi.resetModules();
    const comp = await import('./composition.js');
    comp.resetProductionComposition();
    const health = await import('../app/api/health/route');
    const response = await health.GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      service: 'reporting-host',
      checks: [{ name: 'database', ok: true }],
    });
    expect(typeof body.version).toBe('string');
    const v1 = await import('../app/v1/[[...path]]/route');
    expect(() => v1.GET(request('GET', '/v1/errors?site=shop', OPERATOR_KEY))).toThrow(
      /injected composition/,
    );
  });
});

describe('production /v1 through the shipped instrumentation', () => {
  it('refuses every operator route with 401 when no operator key is configured, and writes nothing', async () => {
    const v1 = await boot({ operatorKey: '', organisation: ORGANISATION });
    const keys = await count('reporting_site_keys');
    const audit = await count('audit_events');
    for (const bearer of [undefined, '', 'undefined', 'guess', OPERATOR_KEY]) {
      const answers = [
        await v1.POST(request('POST', '/v1/site-keys', bearer, { name: 'shop' })),
        await v1.DELETE(request('DELETE', '/v1/site-keys/key-0001', bearer)),
        await v1.GET(request('GET', '/v1/errors?site=shop', bearer)),
        await v1.GET(
          request(
            'GET',
            '/v1/errors/series?site=shop&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z',
            bearer,
          ),
        ),
        await v1.GET(request('GET', `/v1/errors/${'a'.repeat(32)}?site=shop`, bearer)),
        await v1.POST(
          request('POST', `/v1/errors/${'a'.repeat(32)}/state`, bearer, {
            site: 'shop',
            state: 'resolved',
            by: { class: 'human', id: 'p' },
          }),
        ),
      ];
      expect(answers.map((answer) => answer.status)).toEqual([401, 401, 401, 401, 401, 401]);
    }
    expect(await count('reporting_site_keys')).toBe(keys);
    expect(await count('audit_events')).toBe(audit);
  });

  it('refuses a wrong operator key, and mints with the right one: 201, the company tenant on the stored key, the secret nowhere stored', async () => {
    const v1 = await boot({ operatorKey: OPERATOR_KEY, organisation: ORGANISATION });
    const wrong = await v1.POST(
      request('POST', '/v1/site-keys', `${OPERATOR_KEY.slice(0, -1)}x`, { name: 'shop' }),
    );
    expect(wrong.status).toBe(401);

    const response = await v1.POST(
      request('POST', '/v1/site-keys', OPERATOR_KEY, { name: 'mint-check', site: 'shop' }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; secret: string };
    expect(body.secret.startsWith('ci_rk_')).toBe(true);
    const [row] =
      (await held.store?.rows(
        `select tenant_id, site, environment from reporting_site_keys where id = '${body.id}'`,
      )) ?? [];
    expect(row).toEqual({
      tenant_id: tenantIdOf(ORGANISATION),
      site: 'shop',
      environment: 'production',
    });
    const stored = JSON.stringify([
      await held.store?.rows('select * from reporting_site_keys'),
      await held.store?.rows('select * from audit_events'),
    ]);
    expect(stored).not.toContain(body.secret);
    expect(held.roleChecks).toBeGreaterThan(0);
  });

  it('ingests with a minted key, reads it back, and refuses an unknown or revoked key with 401', async () => {
    const v1 = await boot({ operatorKey: OPERATOR_KEY, organisation: ORGANISATION });
    const minted = (await (
      await v1.POST(
        request('POST', '/v1/site-keys', OPERATOR_KEY, {
          name: 'ingest-check',
          site: 'blog',
          environment: 'stage',
        }),
      )
    ).json()) as { id: string; secret: string };
    const report = {
      errors: [{ kind: 'RangeError', message: 'index out of range', runtime: 'server' }],
    };

    const accepted = await v1.POST(request('POST', '/v1/errors', minted.secret, report));
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ accepted: 1 });

    const listed = await v1.GET(
      request('GET', '/v1/errors?site=blog&environment=stage', OPERATOR_KEY),
    );
    expect(listed.status).toBe(200);
    const { items } = (await listed.json()) as {
      items: { site: string; environment: string; message: string }[];
    };
    expect(items).toMatchObject([
      { site: 'blog', environment: 'stage', message: 'index out of range' },
    ]);

    expect((await v1.POST(request('POST', '/v1/errors', 'ci_rk_unknown', report))).status).toBe(
      401,
    );
    expect(
      (await v1.DELETE(request('DELETE', `/v1/site-keys/${minted.id}`, OPERATOR_KEY))).status,
    ).toBe(204);
    expect((await v1.POST(request('POST', '/v1/errors', minted.secret, report))).status).toBe(401);
  });

  it("redacts the host's own runtime connection string from a stored report", async () => {
    const v1 = await boot({ operatorKey: OPERATOR_KEY, organisation: ORGANISATION });
    const { secret } = (await (
      await v1.POST(
        request('POST', '/v1/site-keys', OPERATOR_KEY, { name: 'redact-check', site: 'docs' }),
      )
    ).json()) as { secret: string };
    const sent = await v1.POST(
      request('POST', '/v1/errors', secret, {
        errors: [{ message: `could not connect to ${DATABASE_URL}`, runtime: 'server' }],
      }),
    );
    expect(sent.status).toBe(202);
    const stored = JSON.stringify([
      await held.store?.rows("select message, stack from reporting_errors where site = 'docs'"),
      await held.store?.rows("select message, data from reporting_events where site = 'docs'"),
    ]);
    expect(stored).toContain('could not connect to');
    expect(stored).not.toContain('runtime-password-for-the-test');
  });

  it('answers 503 not_configured to a mint when AUTH_ORGANIZATION_ID is not set, and stores nothing', async () => {
    const v1 = await boot({ operatorKey: OPERATOR_KEY, organisation: '' });
    const keys = await count('reporting_site_keys');
    const response = await v1.POST(
      request('POST', '/v1/site-keys', OPERATOR_KEY, { name: 'no-tenant' }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'not_configured' } });
    expect(await count('reporting_site_keys')).toBe(keys);
  });

  it('answers 404 on an unknown path under /v1', async () => {
    const v1 = await boot({ operatorKey: OPERATOR_KEY, organisation: ORGANISATION });
    const response = await v1.GET(request('GET', '/v1/nothing-here', OPERATOR_KEY));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('warns at boot, naming the variable and never a value, when the operator key or the organisation id is missing', async () => {
    const lines = async (operatorKey: string, organisation: string): Promise<unknown[]> => {
      vi.stubEnv('REPORTING_OPERATOR_KEY', operatorKey);
      vi.stubEnv('AUTH_ORGANIZATION_ID', organisation);
      vi.resetModules();
      const comp = await import('./composition.js');
      comp.resetProductionComposition();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await (await import('../instrumentation')).register();
        return warn.mock.calls.map(([line]) => JSON.parse(String(line)));
      } finally {
        warn.mockRestore();
      }
    };

    expect(await lines(OPERATOR_KEY, ORGANISATION)).toEqual([]);
    expect(await lines('', ORGANISATION)).toEqual([
      {
        level: 'warn',
        message:
          'reporting: REPORTING_OPERATOR_KEY is not set: the operator routes will answer 401 to every caller',
        meta: { variable: 'REPORTING_OPERATOR_KEY' },
      },
    ]);
    const noOrganisation = await lines(OPERATOR_KEY, '');
    expect(noOrganisation).toEqual([
      {
        level: 'warn',
        message:
          'reporting: AUTH_ORGANIZATION_ID is not set: minting a site key will answer 503 not_configured',
        meta: { variable: 'AUTH_ORGANIZATION_ID' },
      },
    ]);
    expect(JSON.stringify(noOrganisation)).not.toContain(OPERATOR_KEY);
    expect(
      (await lines('', '')).map((line) => (line as { meta: { variable: string } }).meta.variable),
    ).toEqual(['REPORTING_OPERATOR_KEY', 'AUTH_ORGANIZATION_ID']);
  });
});
