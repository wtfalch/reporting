import { randomUUID } from 'node:crypto';
import type { Database } from '@wtfalch/db';
import { createDatabase } from '@wtfalch/db/postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UnsafeRuntimeRoleError, checkRuntimeRoleOnce, guardedHandler } from './runtime-role-guard';

/**
 * `checkRuntimeRoleOnce` (the guard's own once-per-connection wrapper around
 * `@wtfalch/db`'s `assertRuntimeRole`) against real Postgres roles -- a fake
 * store proves the wiring in `reporting-host.test.ts` and `guarded-handler.test.ts`;
 * this proves the check itself, which only means anything against a role
 * Postgres actually enforces something on. Real Postgres only: PGlite is always
 * effectively a superuser connection, so "refuses a superuser" would pass
 * vacuously there and "accepts a restricted role" has no restricted role to be.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'checkRuntimeRoleOnce: refuses a role that could bypass row-level security',
  () => {
    const url = process.env.TEST_DATABASE_URL as string;
    let schema: string;
    let adminConnection: ReturnType<typeof createDatabase>;
    let admin: Database;

    /** A connection as `roleName` (or as the test database's own role when
     * omitted), never reused across tests: the check's result is cached per
     * connection object. */
    function connect(roleName?: string) {
      const target = new URL(url);
      if (roleName) {
        target.username = roleName;
        target.password = 'guard-test-only';
      }
      return createDatabase({ url: target.toString(), max: 1, searchPath: [schema, 'public'] });
    }

    async function createRole(prefix: string, grants: string): Promise<string> {
      const roleName = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      await admin.query(
        `CREATE ROLE ${roleName} LOGIN PASSWORD 'guard-test-only' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
      await admin.query(`GRANT ${grants} ON SCHEMA ${schema} TO ${roleName}`);
      return roleName;
    }

    async function dropRole(roleName: string): Promise<void> {
      await admin.query(`DROP OWNED BY ${roleName}`);
      await admin.query(`DROP ROLE ${roleName}`);
    }

    beforeAll(async () => {
      schema = `guard_test_${randomUUID().replaceAll('-', '')}`;
      adminConnection = createDatabase({ url, max: 1 });
      admin = adminConnection.database;
      await admin.query(`CREATE SCHEMA ${schema}`);
    });

    afterAll(async () => {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await adminConnection.close();
    });

    it('refuses a superuser connection', async () => {
      const connection = connect();
      try {
        const check = checkRuntimeRoleOnce(connection.database);
        await expect(check).rejects.toThrow(UnsafeRuntimeRoleError);
        await expect(check).rejects.toThrow(/superuser/);
      } finally {
        await connection.close();
      }
    });

    it('accepts a real, restricted, non-owner role', async () => {
      const roleName = await createRole('guard_role', 'USAGE');
      try {
        const connection = connect(roleName);
        try {
          await expect(checkRuntimeRoleOnce(connection.database)).resolves.toBeUndefined();
        } finally {
          await connection.close();
        }
      } finally {
        await dropRole(roleName);
      }
    });

    it('refuses a role that owns a table, even when neither superuser nor BYPASSRLS', async () => {
      const roleName = await createRole('guard_owner', 'USAGE, CREATE');
      try {
        const connection = connect(roleName);
        try {
          await connection.database.query('CREATE TABLE guard_owned_by_test (id uuid PRIMARY KEY)');
          const check = checkRuntimeRoleOnce(connection.database);
          await expect(check).rejects.toThrow(UnsafeRuntimeRoleError);
          await expect(check).rejects.toThrow(/owns/);
        } finally {
          await connection.close();
        }
      } finally {
        await dropRole(roleName);
      }
    });

    it('guardedHandler answers 503 and never calls the handler when the check fails', async () => {
      const connection = connect();
      try {
        let called = 0;
        const handle = guardedHandler(connection.database, async () => {
          called++;
          return new Response(null, { status: 204 });
        });
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
          const response = await handle(new Request('https://reporting.test/v1/errors'));
          expect(response.status).toBe(503);
          expect(await response.json()).toEqual({
            error: { code: 'unavailable', message: 'Service unavailable' },
          });
        } finally {
          error.mockRestore();
        }
        expect(called).toBe(0);
      } finally {
        await connection.close();
      }
    });
  },
);
