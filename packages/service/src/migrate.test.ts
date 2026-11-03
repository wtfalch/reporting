import { readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteDatabase } from '@wtfalch/db/pglite';
import { migrationsDir } from '@wtfalch/reporting-core/migrations-dir';
import { describe, expect, it } from 'vitest';
import { migrate } from './migrate.js';

describe('migrate', () => {
  it('applies every migration under @wtfalch/reporting-core/migrations-dir, idempotently', async () => {
    const client = new PGlite();
    const owner = createPgliteDatabase(client);
    try {
      const names = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
      const first = await migrate({ owner, log: () => undefined });
      expect(first.applied.map((a) => a.filename).sort()).toEqual(names.sort());

      const second = await migrate({ owner, log: () => undefined });
      expect(second.applied).toHaveLength(0);
    } finally {
      await owner.close();
    }
  });
});
