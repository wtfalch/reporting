import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedSchema } from './real-schema';

/**
 * A temp table named like a real table shadows it inside a SECURITY DEFINER
 * function unless `pg_temp` is last on the function's `search_path`. The
 * migration runner sets that path on the functions it creates (`set
 * search_path from current`); `@wtfalch/db` 0.5.0 and 0.5.1 left `pg_temp` off
 * it, so the host pins 0.5.2. A function that pins a literal path must list
 * `pg_temp` last itself. Core's migrations create seven, every one with `set
 * search_path from current`. Real Postgres only: PGlite does not keep
 * `proconfig` the same way.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'every SECURITY DEFINER function in the schema ends its search_path with pg_temp',
  () => {
    let fixture: Awaited<ReturnType<typeof migratedSchema>>;

    beforeAll(async () => {
      fixture = await migratedSchema('definer_path');
    });

    afterAll(async () => {
      await fixture.close();
    });

    it('all of them', async () => {
      const rows = await fixture.admin.query<{ name: string; config: string[] | null }>(
        `SELECT p.proname AS name, p.proconfig AS config FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.prosecdef`,
        [fixture.schema],
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const setting = (row.config ?? []).find((entry) => entry.startsWith('search_path='));
        expect(setting, `${row.name} has no search_path`).toBeDefined();
        const path = (setting as string).slice('search_path='.length).split(',');
        expect(path.at(-1)?.trim(), `${row.name}: ${setting}`).toBe('pg_temp');
      }
    });
  },
);
