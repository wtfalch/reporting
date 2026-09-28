import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './migrate.js';
import { createReporting, listReportings } from './store.js';
import { testDatabase } from './test/db.js';

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeEach(async () => {
  database = await testDatabase();
});
afterEach(async () => database.close());

describe('reporting store', () => {
  it('round-trips a created reporting through listReportings', async () => {
    const created = await createReporting(database.db, { organisationId: 'org-1', name: 'Widget' });
    expect(created).toMatchObject({ organisationId: 'org-1', name: 'Widget' });
    expect(typeof created.id).toBe('string');
    expect(new Date(created.createdAt).toString()).not.toBe('Invalid Date');
    await expect(listReportings(database.db, 'org-1')).resolves.toEqual([created]);
  });

  it('never lets one organisation see another organisation reportings', async () => {
    await createReporting(database.db, { organisationId: 'org-1', name: 'Org 1 reporting' });
    await createReporting(database.db, { organisationId: 'org-2', name: 'Org 2 reporting' });
    await expect(
      listReportings(database.db, 'org-1').then((rows) => rows.map((r) => r.name)),
    ).resolves.toEqual(['Org 1 reporting']);
    await expect(
      listReportings(database.db, 'org-2').then((rows) => rows.map((r) => r.name)),
    ).resolves.toEqual(['Org 2 reporting']);
  });

  it('is idempotent: reapplying migrations applies nothing new', async () => {
    await expect(migrate(database.db)).resolves.toEqual([]);
    await expect(migrate(database.db)).resolves.toEqual([]);
  });
});
