import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CreateAlertsOptions, createAlerts, readAlertRules } from './alerts.js';
import { writeAudit } from './audit.js';
import { ingestErrors } from './ingest.js';
import { errorSeries } from './reads.js';
import { mintSiteKey, tenantIdOf } from './site-keys.js';
import { inTenant } from './tenant.js';
import { type TestDb, memoryLog, testDb } from './test/db.js';

const TENANT = tenantIdOf('org_acme');
const OTHER = tenantIdOf('org_other');

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t.close();
});

const setting = async () =>
  (await t.query("select current_setting('app.tenant_id', true) as v"))[0]?.v;

describe('inTenant', () => {
  it('sets app.tenant_id inside the work and leaves it empty after, on the same handle', async () => {
    const seen = await inTenant(t.db, TENANT, async (tx) => {
      const rows = await tx.execute<{ v: string }>(
        sql`select current_setting('app.tenant_id', true) as v`,
      );
      return (rows as unknown as { rows: { v: string }[] }).rows[0]?.v;
    });
    expect(seen).toBe(TENANT);
    expect(await setting()).toBe('');
  });

  it('runs set_config as the first statement of its transaction', async () => {
    t.clearLog();
    await inTenant(t.db, TENANT, (tx) => errorSeries(tx, seriesOptions()));
    expect(t.statements[0]).not.toHaveProperty('tx', null);
    expect(t.statements[0]?.sql).toContain("set_config('app.tenant_id'");
    expect(t.statements[0]?.params).toEqual([TENANT]);
  });

  it('a nested inTenant is a savepoint and leaves the outer value', async () => {
    const result = await inTenant(t.db, TENANT, async (outer) => {
      await inTenant(outer, TENANT, async () => undefined);
      return outer.execute(sql`select current_setting('app.tenant_id', true) as v`);
    });
    expect((result as unknown as { rows: { v: string }[] }).rows[0]?.v).toBe(TENANT);
    expect(t.statements.some((s) => /^savepoint/i.test(s.sql))).toBe(true);
  });

  it('a throw inside rolls back the writes', async () => {
    await expect(
      inTenant(t.db, TENANT, async (tx) => {
        await writeAudit(tx, TENANT, { operation: 'site_key.revoke', keyId: 'k-rollback' });
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect(await t.query("select 1 from audit_events where key_id = 'k-rollback'")).toEqual([]);
  });

  it.each(['', 'not-a-uuid', `${TENANT}x`, "00000000-0000-4000-8000-00000000000'"])(
    'a bad id (%j) throws before any SQL',
    async (id) => {
      t.clearLog();
      await expect(inTenant(t.db, id, async () => 1)).rejects.toThrow('must be a UUID');
      expect(t.statements).toEqual([]);
    },
  );
});

function seriesOptions() {
  return {
    site: 'shop',
    environment: 'production' as const,
    from: new Date('2026-11-02T00:00:00Z'),
    to: new Date('2026-11-02T01:00:00Z'),
    bucketMinutes: 60 as const,
  };
}

describe('a bare Db does not typecheck', () => {
  // Each line passes the bare handle `t.db`; `tsc` (pnpm typecheck) fails if
  // the @ts-expect-error below it stops being an error. Never called.
  const neverRun = async () => {
    const options = { site: 'shop', environment: 'production' as const, release: null };
    void options;
    // @ts-expect-error site-keys.ts takes a TenantDb
    await mintSiteKey(t.db, { name: 'a', site: 'a', environment: 'production', tenantId: OTHER });
    // @ts-expect-error reads.ts takes a TenantDb
    await errorSeries(t.db, seriesOptions());
    // @ts-expect-error ingest.ts takes a TenantDb
    await ingestErrors({ db: t.db, log: memoryLog(), now: () => new Date() }, key(), []);
    // @ts-expect-error alerts.ts takes a TenantDb
    await readAlertRules(t.db, 'shop');
    // @ts-expect-error audit.ts takes a TenantDb
    await writeAudit(t.db, null, { operation: 'site_key.revoke', keyId: 'k' });
    // alerts.ts's createAlerts keeps a bare Db: it opens its own inTenant.
    const alertOptions: CreateAlertsOptions = {
      db: t.db,
      tenantId: TENANT,
      mail: null,
      log: memoryLog(),
    };
    createAlerts(alertOptions);
  };
  it('is declared', () => {
    expect(typeof neverRun).toBe('function');
  });
});

function key() {
  return { id: 'k', site: 'shop', environment: 'production' as const, tenantId: TENANT };
}

describe('app.tenant_id is named in one place', () => {
  const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
  const ALLOWED = new Set([
    'packages/service/src/tenant.ts',
    'packages/reporting/src/migrations/0012_tenant_policies.sql',
    'packages/service/src/migrations/0006_tenant_policies.sql',
  ]);
  const MAX_DEPTH = 8;

  /** Every non-test file under `dir`. An unreadable directory throws, and so does a symlink: nothing is skipped. */
  function sourceFiles(dir: string, depth = 0): string[] {
    if (depth > MAX_DEPTH) throw new Error(`too deep: ${dir}`);
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink in the scan: ${path}`);
      if (entry.isDirectory()) {
        if (entry.name !== 'test') found.push(...sourceFiles(path, depth + 1));
      } else if (!/\.test\.[cm]?[jt]sx?$/.test(entry.name)) {
        found.push(path);
      }
    }
    return found;
  }

  /** The files under `roots` that name the setting and are not allowed to. */
  function namers(roots: string[]): string[] {
    return roots
      .flatMap((root) => sourceFiles(root))
      .filter((file) => readFileSync(file, 'utf8').includes('app.tenant_id'))
      .map((file) => relative(ROOT, file).split(sep).join('/'))
      .filter((file) => !ALLOWED.has(file));
  }

  it('no other non-test source file of a package or the host names it', () => {
    expect(
      namers([
        join(ROOT, 'packages/service/src'),
        join(ROOT, 'packages/reporting/src'),
        join(ROOT, 'packages/sdk/src'),
        join(ROOT, 'apps/host/src'),
      ]),
    ).toEqual([]);
  });

  it('fails closed on a directory it cannot read', () => {
    expect(() => namers([join(ROOT, 'packages/service/src/no-such-directory')])).toThrow();
  });

  it('finds a file that is not on the allowed list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tenant-scan-'));
    try {
      writeFileSync(join(dir, 'leak.ts'), "export const x = 'app.tenant_id';\n");
      expect(namers([dir])).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
