import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createDatabase } from '@wtfalch/db/postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA } from '../src/lib/connection';
import { NOT_GRANTED, NO_DELETE, RUNTIME_FUNCTIONS } from './runtime-grants.mjs';

const execFileAsync = promisify(execFile);
const MIGRATE_SCRIPT = fileURLToPath(new URL('./migrate.mjs', import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle/', import.meta.url));

describe('migrate.mjs and the server name the same schema', () => {
  it('SCHEMA in migrate.mjs equals SCHEMA in src/lib/connection.ts', () => {
    // Runs on every tier: the two literals disagreeing would put the tables
    // where the server's search_path does not look.
    const source = readFileSync(MIGRATE_SCRIPT, 'utf8');
    expect(/^const SCHEMA = '([^']+)';$/m.exec(source)?.[1]).toBe(SCHEMA);
  });
});

const OPERATOR_KEY = 'operator-key-for-the-test-0123456789';
const ORGANISATION = '314159265358979323';

/**
 * Runs the real `migrate.mjs` as a subprocess -- exactly how the runner
 * image's entrypoint (`apps/host/scripts/start.sh`) invokes it, not a
 * re-implementation of its logic -- against a fresh database, then proves
 * the runtime role it derives from `DATABASE_URL` can actually serve, not
 * just connect, and holds exactly the privileges the service README lists.
 *
 * The incident this closes (analytics ADR 0014): a fresh deploy's
 * `DATABASE_URL` named a role nothing had created, so every DB route answered
 * an error before its own logic ever ran (cms, 2026-09-23). The fix must serve
 * through the exact role `migrate.mjs` just created -- not through the owner.
 *
 * Real Postgres only: roles, grants and the advisory lock do not exist on
 * PGlite.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'migrate.mjs derives a runtime role that can actually serve',
  () => {
    let adminConnection: ReturnType<typeof createDatabase> | undefined;
    let databaseName: string | undefined;
    let roleName: string | undefined;

    afterEach(async () => {
      if (adminConnection && databaseName) {
        await adminConnection.database.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
      }
      // The role is cluster-wide; once its database is gone it holds nothing.
      if (adminConnection && roleName) {
        await adminConnection.database.query(`DROP ROLE IF EXISTS ${roleName}`);
      }
      await adminConnection?.close();
      adminConnection = undefined;
      databaseName = undefined;
      roleName = undefined;
      vi.unstubAllEnvs();
      // Must not leak into any other test file's shared-store singleton.
      // biome-ignore lint/performance/noDelete: test-only env cleanup
      delete process.env.DATABASE_URL;
      // biome-ignore lint/performance/noDelete: test-only env cleanup
      delete process.env.DATABASE_URL_OWNER;
    });

    /** A fresh database on the test server, and an owner and runtime URL for it. */
    async function freshDatabase(): Promise<{ ownerUrl: URL; runtimeUrl: URL }> {
      const base = new URL(process.env.TEST_DATABASE_URL as string);
      databaseName = `migrate_test_${randomUUID().replaceAll('-', '')}`;
      adminConnection = createDatabase({ url: base.toString(), max: 1 });
      await adminConnection.database.query(`CREATE DATABASE ${databaseName}`);

      const ownerUrl = new URL(base);
      ownerUrl.pathname = `/${databaseName}`;
      const runtimeUrl = new URL(ownerUrl);
      roleName = `migrate_rt_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      runtimeUrl.username = roleName;
      runtimeUrl.password = randomUUID();
      return { ownerUrl, runtimeUrl };
    }

    async function migrate(ownerUrl: URL, runtimeUrl: URL): Promise<string> {
      const { stdout } = await execFileAsync(process.execPath, [MIGRATE_SCRIPT], {
        env: {
          ...process.env,
          DATABASE_URL_OWNER: ownerUrl.toString(),
          DATABASE_URL: runtimeUrl.toString(),
        },
      });
      return stdout;
    }

    it('a fresh database, migrated, mints, ingests, lists and changes state through the derived runtime role', async () => {
      const { ownerUrl, runtimeUrl } = await freshDatabase();

      await migrate(ownerUrl, runtimeUrl);

      // The production composition, as instrumentation.ts injects it.
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('DATABASE_URL', runtimeUrl.toString());
      vi.resetModules();
      const { configureProductionComposition, resetProductionComposition } = await import(
        '../src/lib/composition.js'
      );
      const { tenantIdOf } = await import('@wtfalch/reporting-service');
      resetProductionComposition();
      configureProductionComposition({
        operatorKey: OPERATOR_KEY,
        tenantId: tenantIdOf(ORGANISATION),
      });
      const { sharedHost, sharedHealth } = await import('../src/lib/reporting-host.js');
      const host = sharedHost();
      const operator = { authorization: `Bearer ${OPERATOR_KEY}` };

      const health = await sharedHealth()();
      expect(health.status).toBe(200);

      const minted = await host.handleV1(
        new Request('https://reporting.test/v1/site-keys', {
          method: 'POST',
          headers: operator,
          body: JSON.stringify({ name: 'shop', site: 'shop', environment: 'production' }),
        }),
      );
      expect(minted.status).toBe(201);
      const { secret } = (await minted.json()) as { secret: string };

      const sent = await host.handleV1(
        new Request('https://reporting.test/v1/errors', {
          method: 'POST',
          headers: { authorization: `Bearer ${secret}` },
          body: JSON.stringify({
            errors: [{ kind: 'TypeError', message: 'x is undefined', runtime: 'server' }],
          }),
        }),
      );
      expect(sent.status).toBe(202);
      expect(await sent.json()).toEqual({ accepted: 1 });

      const listed = await host.handleV1(
        new Request('https://reporting.test/v1/errors?site=shop', { headers: operator }),
      );
      expect(listed.status).toBe(200);
      const { items } = (await listed.json()) as { items: { fingerprint: string }[] };
      expect(items).toHaveLength(1);

      const changed = await host.handleV1(
        new Request(`https://reporting.test/v1/errors/${items[0]?.fingerprint}/state`, {
          method: 'POST',
          headers: operator,
          body: JSON.stringify({
            site: 'shop',
            state: 'resolved',
            by: { class: 'human', id: 'person-1' },
          }),
        }),
      );
      expect(changed.status).toBe(200);

      const owner = createDatabase({ url: ownerUrl.toString(), max: 1 });
      try {
        const audit = await owner.database.query<{ operation: string; tenant_id: string }>(
          `SELECT operation, tenant_id FROM ${SCHEMA}.audit_events ORDER BY id`,
        );
        expect(audit.map((row) => row.operation)).toEqual(['site_key.mint', 'error.state']);
        expect(new Set(audit.map((row) => row.tenant_id))).toEqual(
          new Set([tenantIdOf(ORGANISATION)]),
        );
      } finally {
        await owner.close();
      }
    }, 60_000);

    it('puts every table and the ledger in the schema, none in public, and a second run is a no-op', async () => {
      const { ownerUrl, runtimeUrl } = await freshDatabase();

      const first = await migrate(ownerUrl, runtimeUrl);
      expect(first).toMatch(/applying reporting\/0001_reporting\.sql/);
      expect(first).toMatch(/applying reporting-service\/0001_site_keys\.sql/);
      // Core's whole source before the service's first file.
      expect(first.indexOf('reporting/0011_')).toBeLessThan(
        first.indexOf('reporting-service/0001_'),
      );
      expect(await migrate(ownerUrl, runtimeUrl)).not.toMatch(/applying/);

      const owner = createDatabase({ url: ownerUrl.toString(), max: 1 });
      const runtime = createDatabase({ url: runtimeUrl.toString(), max: 1 });
      try {
        const tables = await owner.database.query<{ schema: string; name: string }>(
          `SELECT schemaname AS schema, tablename AS name FROM pg_tables
           WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
        );
        expect(tables.length).toBeGreaterThan(0);
        expect(tables.filter((t) => t.schema !== SCHEMA)).toEqual([]);
        expect(tables.map((t) => t.name)).toEqual(
          expect.arrayContaining([
            'reporting_events',
            'reporting_errors',
            'reporting_site_keys',
            'audit_events',
            '_migrations_sources',
          ]),
        );

        const [row] = await runtime.database.query<{ schema: string }>(
          'SELECT current_schema() AS schema',
        );
        expect(row?.schema).toBe(SCHEMA);

        // The ledger is read-only for the runtime role: a privilege error (42501).
        const code = await runtime.database
          .query('DELETE FROM _migrations_sources')
          .then(() => 'allowed')
          .catch((error: { code?: string }) => error.code);
        expect(code).toBe('42501');
      } finally {
        await owner.close();
        await runtime.close();
      }
    }, 60_000);

    /**
     * analytics#13, part 1: the runner hands the server the whole file, so a
     * semicolon inside a `$$ ... $$` function body is never a splitting
     * decision. This proves it for a file in the host's own directory.
     */
    it('applies a host migration whose function body contains a semicolon inside $$ ... $$', async () => {
      const { ownerUrl, runtimeUrl } = await freshDatabase();

      const fixture = `${MIGRATIONS_DIR}9999_test_dollar_quote_probe.sql`;
      await writeFile(
        fixture,
        [
          'create table dollar_quote_probe (id int primary key, note text);',
          'create function dollar_quote_probe_fn() returns int',
          'language plpgsql as $$',
          'begin',
          "  insert into dollar_quote_probe (id, note) values (1, 'a;b');",
          '  return 1;',
          'end;',
          '$$;',
          'select dollar_quote_probe_fn();',
          '',
        ].join('\n'),
      );
      try {
        await migrate(ownerUrl, runtimeUrl);
      } finally {
        await unlink(fixture);
      }

      const owner = createDatabase({ url: ownerUrl.toString(), max: 1 });
      try {
        const rows = await owner.database.query<{ id: number; note: string }>(
          `SELECT id, note FROM ${SCHEMA}.dollar_quote_probe`,
        );
        expect(rows).toEqual([{ id: 1, note: 'a;b' }]);
      } finally {
        await owner.close();
      }
    }, 60_000);

    /**
     * analytics#13, part 2: `ensureRuntimeRole` grants DML on every table on
     * every boot, so without the lists it would re-grant what a migration (or
     * the README) takes away. These are the service README's grants, on the
     * real role, after a real run.
     */
    it('holds the runtime role to the service README: audit_events and reporting_events append only, no deletes', async () => {
      const { ownerUrl, runtimeUrl } = await freshDatabase();

      await migrate(ownerUrl, runtimeUrl);

      const runtime = createDatabase({ url: runtimeUrl.toString(), max: 1 });
      const codeOf = (text: string) =>
        runtime.database
          .query(text)
          .then(() => 'allowed')
          .catch((error: { code?: string }) => error.code);
      try {
        await expect(
          runtime.database.query("INSERT INTO audit_events (operation) VALUES ('site_key.mint')"),
        ).resolves.toBeDefined();
        await expect(runtime.database.query('SELECT * FROM audit_events')).resolves.toHaveLength(1);
        for (const verb of [
          "UPDATE audit_events SET operation = 'site_key.revoke'",
          'DELETE FROM audit_events',
          'TRUNCATE audit_events',
          'UPDATE reporting_events SET site = site',
          'DELETE FROM reporting_events',
        ]) {
          expect(await codeOf(verb), verb).toBe('42501');
        }

        // Site keys: select, insert, update; never delete.
        await expect(
          runtime.database.query(
            `INSERT INTO reporting_site_keys (id, name, secret_hash, site, environment, tenant_id)
             VALUES ('key-0001', 'shop', repeat('a', 64), 'shop', 'production', gen_random_uuid())`,
          ),
        ).resolves.toBeDefined();
        expect(await codeOf('UPDATE reporting_site_keys SET revoked_at = now()')).toBe('allowed');
        for (const table of NO_DELETE) {
          expect(await codeOf(`DELETE FROM ${table}`), table).toBe('42501');
        }

        // Core's housekeeping functions are callable; the moved analytics ones are not.
        for (const signature of RUNTIME_FUNCTIONS) {
          const [row] = await runtime.database.query<{ ok: boolean }>(
            "SELECT has_function_privilege(to_regprocedure($1), 'EXECUTE') AS ok",
            [signature],
          );
          expect(row?.ok, signature).toBe(true);
        }
        for (const signature of NOT_GRANTED) {
          const [row] = await runtime.database.query<{ ok: boolean }>(
            "SELECT has_function_privilege(to_regprocedure($1), 'EXECUTE') AS ok",
            [signature],
          );
          expect(row?.ok, signature).toBe(false);
        }

        // The guard checks the same lists: it passes this role, and refuses it
        // once someone grants it a delete the README does not list.
        const { checkRuntimeRoleOnce, UnsafeRuntimeRoleError } = await import(
          '../src/lib/runtime-role-guard.js'
        );
        await expect(checkRuntimeRoleOnce(runtime.database)).resolves.toBeUndefined();
        const owner = createDatabase({ url: ownerUrl.toString(), max: 1 });
        try {
          await owner.database.query(
            `GRANT DELETE ON ${SCHEMA}.audit_events TO ${runtimeUrl.username}`,
          );
        } finally {
          await owner.close();
        }
        const fresh = createDatabase({ url: runtimeUrl.toString(), max: 1 });
        try {
          await expect(checkRuntimeRoleOnce(fresh.database)).rejects.toThrow(
            UnsafeRuntimeRoleError,
          );
        } finally {
          await fresh.close();
        }
      } finally {
        await runtime.close();
      }
    }, 60_000);

    it('a failed run exits non-zero and prints the error name only, never a URL or a role', async () => {
      const { ownerUrl } = await freshDatabase();
      // The runtime URL naming the owner role is refused outright by
      // ensureRuntimeRole, after the migrations ran.
      const failure = await execFileAsync(process.execPath, [MIGRATE_SCRIPT], {
        env: {
          ...process.env,
          DATABASE_URL_OWNER: ownerUrl.toString(),
          DATABASE_URL: ownerUrl.toString(),
        },
      }).then(
        () => null,
        (error: { code?: number; stderr?: string }) => error,
      );
      expect(failure?.code).toBe(1);
      const stderr = failure?.stderr ?? '';
      expect(stderr.trim()).toMatch(/^migrate: failed \([A-Za-z]+( [0-9A-Z]{5})?\)$/);
      expect(stderr).not.toContain(ownerUrl.username);
      expect(stderr).not.toContain(ownerUrl.host);
    }, 60_000);
  },
);
