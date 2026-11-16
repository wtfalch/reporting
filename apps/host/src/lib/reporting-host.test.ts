import type { Queryable } from '@wtfalch/db';
import type { CreateReportingHandlerOptions } from '@wtfalch/reporting-service';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEVELOPMENT_OPERATOR_KEY,
  DEVELOPMENT_SITE_KEY,
  DEVELOPMENT_TENANT_ID,
  developmentSiteKeys,
} from './composition.js';
import { createReportingHost } from './reporting-host.js';
import { UnsafeRuntimeRoleError } from './runtime-role-guard.js';

// The role check is `@wtfalch/db`'s `assertRuntimeRole`, which needs a real
// database: `runtime-role-guard.test.ts` runs it against real roles. Here it is
// replaced, to prove the wiring: /api/health and /v1 report what it says.
const assertRuntimeRole = vi.hoisted(() => vi.fn());
vi.mock('@wtfalch/db/runtime-role', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wtfalch/db/runtime-role')>()),
  assertRuntimeRole,
}));

/** A Drizzle handle that fails the test if the service touches it at all. */
const untouchedDb = new Proxy(
  {},
  {
    get() {
      throw new Error('store should not be touched');
    },
  },
) as CreateReportingHandlerOptions['db'];

/** Each call gets a fresh object: the role verdict is cached per connection. */
function database(query: (text: string) => Promise<unknown[]> = async () => []): Queryable {
  return { query } as unknown as Queryable;
}

function host(db: Queryable, operatorKey?: string) {
  return createReportingHost({
    db: untouchedDb,
    database: db,
    operatorKey,
    tenantId: DEVELOPMENT_TENANT_ID,
  });
}

afterEach(() => {
  assertRuntimeRole.mockReset();
  vi.unstubAllEnvs();
});

describe('reporting-host composition root', () => {
  it('answers /api/health with 200, a version and a passing database check once the role check and a live query both pass', async () => {
    assertRuntimeRole.mockResolvedValue(undefined);
    vi.stubEnv('APP_VERSION', 'abc123');
    const query = vi.fn(async () => [{ '?column?': 1 }]);
    const response = await host(database(query)).handleHealth();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      ok: true,
      service: 'reporting-host',
      version: 'abc123',
      checks: [{ name: 'database', ok: true }],
    });
    expect(query).toHaveBeenCalledWith('select 1');
  });

  it('answers /api/health with 503 naming the database check, and no error text, when the connected role is unsafe (analytics ADR 0014)', async () => {
    assertRuntimeRole.mockRejectedValue(new UnsafeRuntimeRoleError('reporting_owner is superuser'));
    const response = await host(database()).handleHealth();
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      ok: false,
      checks: [{ name: 'database', ok: false }],
    });
    expect(text).not.toContain('superuser');
  });

  it('answers /api/health with 503, and no error text, when the role check passes but the query itself fails', async () => {
    assertRuntimeRole.mockResolvedValue(undefined);
    const response = await host(
      database(async () => {
        throw new Error('connect ECONNREFUSED db.internal:5432');
      }),
    ).handleHealth();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('db.internal');
  });

  it('does not cache a healthy database check: a second call after the database dies answers 503', async () => {
    assertRuntimeRole.mockResolvedValue(undefined);
    let alive = true;
    const reporting = host(
      database(async () => {
        if (!alive) throw new Error('gone');
        return [];
      }),
    );
    expect((await reporting.handleHealth()).status).toBe(200);
    alive = false;
    expect((await reporting.handleHealth()).status).toBe(503);
  });

  it('reports maintenance:true with status 200 even when the database check fails', async () => {
    assertRuntimeRole.mockResolvedValue(undefined);
    vi.stubEnv('MAINTENANCE', 'true');
    const response = await host(
      database(async () => {
        throw new Error('down');
      }),
    ).handleHealth();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, maintenance: true });
  });

  it('answers /v1 with 503 unavailable, store untouched, when the connected role is unsafe', async () => {
    assertRuntimeRole.mockRejectedValue(new UnsafeRuntimeRoleError('unsafe'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await host(database(), 'operator-key').handleV1(
        new Request('https://reporting.test/v1/errors?site=shop', {
          headers: { authorization: 'Bearer operator-key' },
        }),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { code: 'unavailable', message: 'Service unavailable' },
      });
    } finally {
      error.mockRestore();
    }
  });

  it('answers 404 on an unknown path under /v1, store untouched', async () => {
    assertRuntimeRole.mockResolvedValue(undefined);
    const response = await host(database(), 'operator-key').handleV1(
      new Request('https://reporting.test/v1/nothing'),
    );
    expect(response.status).toBe(404);
  });

  it('answers 401 to the operator routes without the operator key, store untouched', async () => {
    assertRuntimeRole.mockResolvedValue(undefined);
    const reporting = host(database());
    const mint = await reporting.handleV1(
      new Request('https://reporting.test/v1/site-keys', {
        method: 'POST',
        headers: { authorization: 'Bearer anything' },
        body: JSON.stringify({ name: 'shop' }),
      }),
    );
    expect(mint.status).toBe(401);
    const list = await reporting.handleV1(
      new Request('https://reporting.test/v1/errors?site=shop', {
        headers: { authorization: 'Bearer anything' },
      }),
    );
    expect(list.status).toBe(401);
  });

  it('does not open a database connection at import time', async () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.resetModules();
    // Importing must not throw for the missing URL; only building the host does.
    const module = await import('./reporting-host.js');
    expect(typeof module.sharedHost).toBe('function');
    vi.stubEnv('NODE_ENV', 'development');
    expect(() => module.sharedHost()).toThrow(/DATABASE_URL is required/);
  });

  it('refuses to start in production with no injected composition', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@localhost:5432/x');
    vi.resetModules();
    (await import('./composition.js')).resetProductionComposition();
    const { sharedHost } = await import('./reporting-host.js');
    expect(() => sharedHost()).toThrow(/injected composition/);
  });

  it('treats an unset or misspelled NODE_ENV as production, never the development key', async () => {
    for (const value of ['', 'prod', 'Development']) {
      vi.stubEnv('NODE_ENV', value);
      vi.stubEnv('DATABASE_URL', 'postgres://u:p@localhost:5432/x');
      vi.resetModules();
      (await import('./composition.js')).resetProductionComposition();
      const { sharedHost } = await import('./reporting-host.js');
      expect(() => sharedHost(), value).toThrow(/injected composition/);
    }
  });

  it('throws from the development entry points outside development and test', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const comp = await import('./composition.js');
    const { developmentHost } = await import('./reporting-host.js');
    expect(() => comp.developmentComposition()).toThrow(/development-only/);
    expect(() => developmentHost()).toThrow(/development-only/);
  });

  it('accepts a production composition of only the operator key and the tenant, and refuses the development key and site key', async () => {
    vi.resetModules();
    const comp = await import('./composition.js');
    comp.resetProductionComposition();
    comp.configureProductionComposition({ operatorKey: 'real-key', tenantId: 'tenant' });
    expect(comp.productionComposition()).toEqual({ operatorKey: 'real-key', tenantId: 'tenant' });
    expect(() =>
      comp.configureProductionComposition({ operatorKey: DEVELOPMENT_OPERATOR_KEY }),
    ).toThrow(/development operator key/);
    expect(() =>
      comp.configureProductionComposition({
        operatorKey: 'real-key',
        siteKeys: comp.developmentSiteKeys,
      }),
    ).toThrow(/development site key/);
    comp.resetProductionComposition();
  });

  it('the development site key resolves to the development tenant, and nothing else resolves', async () => {
    expect(await developmentSiteKeys(DEVELOPMENT_SITE_KEY)).toEqual({
      id: DEVELOPMENT_SITE_KEY,
      site: 'app',
      environment: 'production',
      tenantId: DEVELOPMENT_TENANT_ID,
    });
    expect(await developmentSiteKeys('ci_rk_anything')).toBeNull();
  });
});
