import type { Queryable } from '@wtfalch/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnsafeRuntimeRoleError, checkRuntimeRoleOnce, guardedHandler } from './runtime-role-guard';

// A plain function, not `vi.fn()`: vitest reports a rejection a spy's
// implementation returns as unhandled even when the caller handles it.
// `outcomes` is consumed one per call; `fallback` applies once it is empty.
type Outcome = 'pass' | 'unsafe' | 'transient';
const role = vi.hoisted(() => ({
  calls: 0,
  tables: undefined as unknown,
  outcomes: [] as Outcome[],
  fallback: 'pass' as Outcome,
}));
vi.mock('@wtfalch/db/runtime-role', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wtfalch/db/runtime-role')>();
  return {
    ...actual,
    async assertRuntimeRole(_db: unknown, tables: unknown) {
      role.calls++;
      role.tables = tables;
      const outcome = role.outcomes.shift() ?? role.fallback;
      if (outcome === 'unsafe') throw new actual.UnsafeRuntimeRoleError('unsafe role reporting_rt');
      if (outcome === 'transient') throw new Error('connection refused to db.internal');
    },
  };
});

/** A connection that must never be queried here: the guard's check is mocked. */
function fakeDatabase(): Queryable {
  return { query: vi.fn(async () => []) } as unknown as Queryable;
}

function handlerSpy() {
  const calls: Request[] = [];
  const handle = async (request: Request) => {
    calls.push(request);
    return new Response(null, { status: 204 });
  };
  return { calls, handle };
}

beforeEach(() => {
  role.calls = 0;
  role.tables = undefined;
  role.outcomes = [];
  role.fallback = 'pass';
});

describe('guardedHandler', () => {
  it('passes the request on once the role check passes', async () => {
    const { calls, handle } = handlerSpy();
    const request = new Request('https://reporting.test/v1/errors');
    const response = await guardedHandler(fakeDatabase(), handle)(request);
    expect(response.status).toBe(204);
    expect(calls).toEqual([request]);
  });

  it('checks the service README lists, schema-qualified', async () => {
    await checkRuntimeRoleOnce(fakeDatabase());
    expect(role.tables).toEqual({
      appendOnly: ['reporting.audit_events', 'reporting.reporting_events'],
      noDelete: [
        'reporting.reporting_site_keys',
        'reporting.reporting_tasks',
        'reporting.reporting_settings',
        'reporting.reporting_errors',
        'reporting.reporting_tenant_settings',
        'reporting.reporting_error_tenants',
        'reporting.reporting_requests',
      ],
    });
  });

  it.each(['unsafe', 'transient'] as const)(
    'a %s check answers 503 with the fixed body, never calls the handler, and logs the error name only',
    async (outcome) => {
      role.fallback = outcome;
      const { calls, handle } = handlerSpy();
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const response = await guardedHandler(
          fakeDatabase(),
          handle,
        )(new Request('https://reporting.test/v1/errors'));
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          error: { code: 'unavailable', message: 'Service unavailable' },
        });
        expect(calls).toEqual([]);
        const logged = error.mock.calls.map(([line]) => String(line)).join('\n');
        expect(logged).not.toMatch(/reporting_rt|db\.internal/);
        expect(JSON.parse(String(error.mock.calls[0]?.[0])).meta).toEqual({
          err: outcome === 'unsafe' ? 'UnsafeRuntimeRoleError' : 'Error',
        });
      } finally {
        error.mockRestore();
      }
    },
  );
});

describe('checkRuntimeRoleOnce caches a verdict, not a failure to get one', () => {
  it('retries after a transient error, then caches the pass', async () => {
    role.outcomes = ['transient'];
    const database = fakeDatabase();

    await expect(checkRuntimeRoleOnce(database)).rejects.toThrow('connection refused');
    await expect(checkRuntimeRoleOnce(database)).resolves.toBeUndefined();
    await checkRuntimeRoleOnce(database);

    expect(role.calls).toBe(2);
  });

  it('keeps an UnsafeRuntimeRoleError verdict', async () => {
    role.fallback = 'unsafe';
    const database = fakeDatabase();

    await expect(checkRuntimeRoleOnce(database)).rejects.toThrow(UnsafeRuntimeRoleError);
    await expect(checkRuntimeRoleOnce(database)).rejects.toThrow(UnsafeRuntimeRoleError);

    expect(role.calls).toBe(1);
  });
});
