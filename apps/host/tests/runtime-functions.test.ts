import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOT_GRANTED, RUNTIME_FUNCTIONS } from '../scripts/runtime-grants.mjs';
import { migratedSchema } from './real-schema';

/**
 * A new SECURITY DEFINER function nobody adds to `RUNTIME_FUNCTIONS` would
 * exist but be unreachable by the runtime role (no EXECUTE grant), failing
 * only at the first request that calls it; one nobody adds to `NOT_GRANTED`
 * either is a function nobody decided about. Real Postgres only: PGlite has no
 * roles to grant to.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'every SECURITY DEFINER function in the schema is granted or named as not granted',
  () => {
    let fixture: Awaited<ReturnType<typeof migratedSchema>>;

    beforeAll(async () => {
      fixture = await migratedSchema('definer_test');
    });

    afterAll(async () => {
      await fixture.close();
    });

    it('the two lists name exactly the SECURITY DEFINER functions, with no overlap', async () => {
      const rows = await fixture.admin.query<{ name: string }>(
        `SELECT p.proname AS name FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.prosecdef`,
        [fixture.schema],
      );
      const nameOf = (signature: string) => signature.split('(')[0];
      const granted = RUNTIME_FUNCTIONS.map(nameOf);
      const held = NOT_GRANTED.map(nameOf);
      expect(granted.filter((name) => held.includes(name))).toEqual([]);
      expect(rows.map((row) => row.name).sort()).toEqual([...granted, ...held].sort());
    });

    it('every entry resolves to a function with that exact signature', async () => {
      for (const signature of [...RUNTIME_FUNCTIONS, ...NOT_GRANTED]) {
        const [row] = await fixture.admin.query<{ found: boolean }>(
          'SELECT to_regprocedure($1) IS NOT NULL AS found',
          [`${fixture.schema}.${signature}`],
        );
        expect(row?.found, signature).toBe(true);
      }
    });

    it('PUBLIC may execute none of them: a function left off the grants is not callable', async () => {
      for (const signature of [...RUNTIME_FUNCTIONS, ...NOT_GRANTED]) {
        const [row] = await fixture.admin.query<{ public: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
             WHERE p.oid = to_regprocedure($1) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
           ) AS public`,
          [`${fixture.schema}.${signature}`],
        );
        expect(row?.public, signature).toBe(false);
      }
    });
  },
);
