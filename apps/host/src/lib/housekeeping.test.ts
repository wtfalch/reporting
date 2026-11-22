import type { Queryable } from '@wtfalch/db';
import type { CreateReportingHandlerOptions } from '@wtfalch/reporting-service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteStore } from '../../tests/pglite-store';
import { DEVELOPMENT_TENANT_ID } from './composition.js';
import { createHostHousekeeping, createReportingHost } from './reporting-host.js';

const assertRuntimeRole = vi.hoisted(() => vi.fn());
vi.mock('@wtfalch/db/runtime-role', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wtfalch/db/runtime-role')>()),
  assertRuntimeRole,
}));

// `after` only works inside a Next request; here it runs the callback at once
// and keeps the promise so a test can wait for it.
const afterRuns = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock('next/server', () => ({
  after: (fn: () => Promise<unknown>) => {
    afterRuns.push(fn());
  },
}));

const untouchedDb = new Proxy({}, { get: () => undefined }) as CreateReportingHandlerOptions['db'];
const database = { query: async () => [] } as unknown as Queryable;

beforeEach(() => {
  assertRuntimeRole.mockResolvedValue(undefined);
  afterRuns.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

function hostWith(tick: () => Promise<void>) {
  return createReportingHost({
    db: untouchedDb,
    database,
    tenantId: DEVELOPMENT_TENANT_ID,
    housekeeping: { tick },
  });
}

describe('health runs housekeeping', () => {
  it('calls tick once per health call, after the answer', async () => {
    const tick = vi.fn(async () => undefined);
    const response = await hostWith(tick).handleHealth();
    await Promise.all(afterRuns);
    expect(response.status).toBe(200);
    expect(afterRuns).toHaveLength(1);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('still answers 200 with the same body when the tick throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tick = vi.fn(async () => {
      throw new Error('secret-value');
    });
    const response = await hostWith(tick).handleHealth();
    await expect(Promise.all(afterRuns)).resolves.toBeDefined();
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith('reporting-host: housekeeping tick failed');
  });
});

describe('host housekeeping', () => {
  it('registers the four tasks', async () => {
    const store = await pgliteStore();
    const names = createHostHousekeeping(store.orm as never, DEVELOPMENT_TENANT_ID)
      .tasks()
      .map((task) => task.name)
      .sort();
    expect(names).toEqual([
      'reporting.prune_errors',
      'reporting.prune_events',
      'reporting.prune_open_errors',
      'reporting.retention_lag',
    ]);
  });

  it('sets retention to 90 on a fresh database, recorded as the host', async () => {
    const store = await pgliteStore();
    await createHostHousekeeping(store.orm as never, DEVELOPMENT_TENANT_ID).tick();
    expect(
      await store.rows(
        "select value::text as value, updated_by from reporting_settings where key = 'events.retention_days'",
      ),
    ).toEqual([{ value: '90', updated_by: 'service:reporting-host' }]);
  });

  it('leaves an existing 45 at 45', async () => {
    const store = await pgliteStore();
    await store.rows(
      "insert into reporting_settings (key, value, updated_by) values ('events.retention_days', '45', 'user:op')",
    );
    await createHostHousekeeping(store.orm as never, DEVELOPMENT_TENANT_ID).tick();
    expect(
      await store.rows(
        "select value::text as value, updated_by from reporting_settings where key = 'events.retention_days'",
      ),
    ).toEqual([{ value: '45', updated_by: 'user:op' }]);
  });

  it('runs each prune in a transaction whose first statement binds the tenant', async () => {
    const store = await pgliteStore();
    const housekeeping = createHostHousekeeping(store.orm as never, DEVELOPMENT_TENANT_ID);
    for (const task of housekeeping.tasks()) {
      expect(await housekeeping.runNow(task.name)).toBe('ran');
    }
    const prunes = store.statements.filter((s) => /reporting_prune_/.test(s.sql));
    expect(prunes.length).toBeGreaterThanOrEqual(3);
    for (const prune of prunes) {
      expect(prune.tx).not.toBeNull();
      const first = store.statements.find((s) => s.tx === prune.tx);
      expect(first?.sql).toContain("set_config('app.tenant_id'");
      expect(first?.params).toEqual([DEVELOPMENT_TENANT_ID]);
    }
  });

  it('with no tenant, runs no statement and logs one line naming AUTH_ORGANIZATION_ID', async () => {
    const store = await pgliteStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    store.statements.length = 0;
    await createHostHousekeeping(store.orm as never, undefined).tick();
    expect(store.statements).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('AUTH_ORGANIZATION_ID');
  });
});
