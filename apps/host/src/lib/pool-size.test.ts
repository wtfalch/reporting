import { beforeEach, describe, expect, it, vi } from 'vitest';

// Records what reaches `createDatabase`. The pool size is a budget (one
// Postgres holds about 20 services); a dropped `max` falls back to the library
// default and nothing else would notice.
const created = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@wtfalch/db/postgres', () => ({
  createDatabase(options: Record<string, unknown>) {
    created.push(options);
    return { database: {}, close: async () => undefined };
  },
}));
// The owner above is not a real one; the Drizzle view of it is not under test.
vi.mock('@wtfalch/db/drizzle', () => ({ withDrizzle: () => ({ orm: {} }) }));

describe('connection options reaching createDatabase', () => {
  beforeEach(() => {
    created.length = 0;
    process.env.DATABASE_URL = 'postgres://reporting_rt:pw@localhost:5432/reporting';
    vi.resetModules();
  });

  it('the host store gets one pool of 5 connections, a 15 s statement timeout and the schema on its search_path', async () => {
    const { sharedHost, sharedHealth } = await import('./reporting-host');
    sharedHost();
    sharedHealth();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      applicationName: 'reporting-host',
      max: 5,
      statementTimeoutMs: 15_000,
      searchPath: ['reporting', 'public'],
    });
  });
});
