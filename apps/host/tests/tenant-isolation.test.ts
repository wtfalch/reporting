import { randomUUID } from 'node:crypto';
import { inTenant, tenantIdOf } from '@wtfalch/reporting-service';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgliteStore } from './pglite-store';
import { migratedSchema } from './real-schema';
import { type Rows, asRuntime, createRlsRoles } from './rls-role';

/**
 * Forced row-level security, proved on PGlite in the gate (it has roles, SET
 * LOCAL ROLE and FORCE): the schema is built by `pgliteStore()`, then the
 * tables and the definer functions are handed to a non-superuser owner and
 * the service's runtime role gets its grants (`rls-role.ts`).
 */

const A = tenantIdOf('org_a');
const B = tenantIdOf('org_b');
const OLD = "now() - interval '100 days'";

/** Core tables whose tenant_id may be null, and the two where it may not. */
const NULLABLE = [
  'reporting_events',
  'reporting_analytics',
  'reporting_analytics_daily',
  'reporting_analytics_weekly',
  'reporting_errors',
];
const STRICT = ['reporting_tenant_settings', 'reporting_error_tenants'];

const fingerprint = (n: number) => n.toString(16).padStart(32, '0');

/** One row of `table` for `tenant` (null: no tenant). `n` keeps keys apart. */
function insertOf(table: string, tenant: string | null, n: number, extra = ''): string {
  const t = tenant === null ? 'null' : `'${tenant}'`;
  switch (table) {
    case 'reporting_events':
      return `insert into reporting_events (level, kind, site, message, tenant_id, occurred_at)
        values ('info', 'a.b', 'shop', 'm${n}', ${t}, ${extra || 'now()'})`;
    case 'reporting_analytics':
      return `insert into reporting_analytics (occurred_at, site, name, path, device, tenant_id)
        values (now(), 'shop', 'page', '/p${n}', 'desktop', ${t})`;
    case 'reporting_analytics_daily':
      return `insert into reporting_analytics_daily (day, site, grain, tenant_id, views, visitors, people)
        values (current_date - ${n}, 'shop', 'tenant', ${t}, 1, 1, 1)`;
    case 'reporting_analytics_weekly':
      return `insert into reporting_analytics_weekly (week, site, tenant_id, visitors, returning_visitors, people, returning_people)
        values (current_date - ${n} * 7, 'shop', ${t}, 1, 0, 1, 0)`;
    case 'reporting_errors':
      return `insert into reporting_errors (fingerprint, site, kind, message, runtime, first_seen_at, last_seen_at, tenant_id, state)
        values ('${fingerprint(n)}', 'shop', 'TypeError', 'm', 'server', ${OLD}, ${extra || OLD}, ${t}, 'resolved')`;
    case 'reporting_tenant_settings':
      return `insert into reporting_tenant_settings (tenant_id, key, value) values (${t}, 'events.retention_days', '30')`;
    case 'reporting_error_tenants':
      return `insert into reporting_error_tenants (fingerprint, tenant_id, first_seen_at, last_seen_at)
        values ('${fingerprint(n)}', ${t}, now(), now())`;
    default:
      throw new Error(table);
  }
}

/** Fingerprints 1, 2, 3 are the error groups of A, B and no tenant. */
const FIXTURE_NUMBER = { A: 1, B: 2, none: 3 };

async function seed(rows: Rows): Promise<void> {
  for (const [who, tenant] of [
    ['A', A],
    ['B', B],
    ['none', null],
  ] as const) {
    const n = FIXTURE_NUMBER[who];
    for (const table of NULLABLE) await rows(insertOf(table, tenant, n));
    if (tenant !== null) {
      for (const table of STRICT) await rows(insertOf(table, tenant, n));
    }
  }
}

const tenantsOf = async (rows: Rows, table: string) =>
  (await rows(`select coalesce(tenant_id::text, 'none') as t from ${table} order by 1`)).map((r) =>
    String(r.t),
  );

describe('forced row-level security on PGlite, as a non-superuser runtime role', () => {
  let store: Awaited<ReturnType<typeof pgliteStore>>;
  beforeAll(async () => {
    store = await pgliteStore();
    await createRlsRoles(store.rows);
    await seed(store.rows);
  });

  it.each(NULLABLE)('bound to A, %s shows A and the null-tenant row, not B', async (table) => {
    const seen = await asRuntime(store.rows, A, () => tenantsOf(store.rows, table));
    expect(seen).toEqual([A, 'none'].sort());
  });

  it.each(STRICT)('bound to A, %s shows A only', async (table) => {
    expect(await asRuntime(store.rows, A, () => tenantsOf(store.rows, table))).toEqual([A]);
  });

  it.each([...NULLABLE, ...STRICT])(
    'bound to A, an insert of %s for B is refused by row-level security',
    async (table) => {
      await expect(
        asRuntime(store.rows, A, () => store.rows(insertOf(table, B, 9))),
      ).rejects.toThrow(`new row violates row-level security policy for table "${table}"`);
    },
  );

  it.each(NULLABLE)('bound to A, an insert of %s with no tenant is accepted', async (table) => {
    await asRuntime(store.rows, A, () => store.rows(insertOf(table, null, 9)));
  });

  it.each(NULLABLE)('with no setting, %s shows only the null-tenant row', async (table) => {
    expect(await asRuntime(store.rows, null, () => tenantsOf(store.rows, table))).toEqual(['none']);
  });

  it.each(STRICT)('with no setting, %s shows nothing', async (table) => {
    expect(await asRuntime(store.rows, null, () => tenantsOf(store.rows, table))).toEqual([]);
  });

  it('with no setting, an insert for a tenant is refused', async () => {
    await expect(
      asRuntime(store.rows, null, () => store.rows(insertOf('reporting_events', A, 9))),
    ).rejects.toThrow('new row violates row-level security policy for table "reporting_events"');
  });

  it('the superuser that seeded the rows is not bound: it still sees all three', async () => {
    expect(await tenantsOf(store.rows, 'reporting_events')).toEqual([A, B, 'none'].sort());
  });
});

/** Runs `work` as the table owner (bound by FORCE, as the definer functions are) bound to `tenant`, then rolls back. */
async function asOwner<T>(rows: Rows, tenant: string, work: () => Promise<T>): Promise<T> {
  await rows('begin');
  try {
    await rows('set local role owner_r');
    await rows(`select set_config('app.tenant_id', '${tenant}', true)`);
    return await work();
  } finally {
    await rows('rollback');
    await rows('reset role');
  }
}

describe('the delete policy of each analytics table is permissive', () => {
  let store: Awaited<ReturnType<typeof pgliteStore>>;
  beforeAll(async () => {
    store = await pgliteStore();
    await createRlsRoles(store.rows);
    await seed(store.rows);
  });

  it.each(['reporting_analytics', 'reporting_analytics_daily', 'reporting_analytics_weekly'])(
    'bound to A, a delete on %s removes the row of A and not the row of B',
    async (table) => {
      const mine = await asOwner(store.rows, A, () =>
        store.rows(`delete from ${table} where tenant_id = '${A}' returning tenant_id`),
      );
      expect(mine).toHaveLength(1);
      const theirs = await asOwner(store.rows, A, () =>
        store.rows(`delete from ${table} where tenant_id = '${B}' returning tenant_id`),
      );
      expect(theirs).toEqual([]);
    },
  );
});

describe('the runtime role of the test helper', () => {
  it('uses the schema public and the base tables, and does not hold update on the log tables or delete or truncate anywhere', async () => {
    const store = await pgliteStore();
    await createRlsRoles(store.rows);
    const [row] = await store.rows(`select
      has_schema_privilege('rt', 'public', 'usage') as usage,
      has_schema_privilege('rt', 'public', 'create') as make,
      has_table_privilege('rt', 'reporting_tenant_settings', 'select') as sel,
      has_table_privilege('rt', 'reporting_tenant_settings', 'insert') as ins,
      has_table_privilege('rt', 'reporting_tenant_settings', 'update') as upd,
      has_table_privilege('rt', 'reporting_tenant_settings', 'delete') as del,
      has_table_privilege('rt', 'reporting_events', 'update') as events_upd,
      has_table_privilege('rt', 'reporting_events', 'insert') as events_ins`);
    expect(row).toEqual({
      usage: true,
      make: false,
      sel: true,
      ins: true,
      upd: true,
      del: false,
      events_upd: false,
      events_ins: true,
    });
  });
});

describe('the prune functions, owned by a bound non-superuser, inside inTenant(A)', () => {
  /** Runs `select <call> as n` as rt inside a transaction bound to A, and commits it. */
  async function prune(store: Awaited<ReturnType<typeof pgliteStore>>, call: string) {
    return inTenant(store.orm as never, A, async (tx) => {
      await tx.execute(sql`set local role rt`);
      const result = await tx.execute(sql.raw(`select ${call} as n`));
      return Number((result as unknown as { rows: { n: number }[] }).rows[0]?.n);
    });
  }

  async function fresh() {
    const store = await pgliteStore();
    await createRlsRoles(store.rows);
    return store;
  }

  it('reporting_prune_events deletes the old rows of A and of no tenant, none of B', async () => {
    const store = await fresh();
    for (const tenant of [A, B, null]) {
      await store.rows(insertOf('reporting_events', tenant, 1, OLD));
      await store.rows(insertOf('reporting_events', tenant, 2));
    }
    expect(await prune(store, 'reporting_prune_events(make_interval(days => 30), 5000)')).toBe(2);
    expect(
      (
        await store.rows(
          "select coalesce(tenant_id::text, 'none') as t, message from reporting_events order by 1, 2",
        )
      ).map((r) => `${r.t}/${r.message}`),
    ).toEqual([`${A}/m2`, `${B}/m1`, `${B}/m2`, 'none/m2'].sort());
  });

  it('is red without the DELETE policy: the same call deletes 0 rows, silently', async () => {
    const store = await fresh();
    await store.rows('drop policy reporting_events_tenant_delete on reporting_events');
    for (const tenant of [A, B, null]) {
      await store.rows(insertOf('reporting_events', tenant, 1, OLD));
    }
    expect(await prune(store, 'reporting_prune_events(make_interval(days => 30), 5000)')).toBe(0);
    expect(await store.rows('select 1 from reporting_events')).toHaveLength(3);
  });

  it('reporting_prune_errors deletes the old resolved groups of A and of no tenant, none of B', async () => {
    const store = await fresh();
    for (const [tenant, n] of [
      [A, 1],
      [B, 2],
      [null, 3],
    ] as const) {
      await store.rows(insertOf('reporting_errors', tenant, n));
    }
    expect(await prune(store, 'reporting_prune_errors(make_interval(days => 30), 5000)')).toBe(2);
    expect(
      (await store.rows('select fingerprint from reporting_errors')).map((r) => r.fingerprint),
    ).toEqual([fingerprint(2)]);
  });

  it('reporting_prune_open_errors caps the open groups A can see, and leaves a site of B over the cap alone', async () => {
    const store = await fresh();
    const groups = (site: string, tenant: string, from: number) =>
      store.rows(
        `insert into reporting_errors (fingerprint, site, kind, message, runtime, first_seen_at, last_seen_at, tenant_id)
         select lpad(to_hex(i), 32, '0'), '${site}', 'TypeError', 'm', 'server', now() - interval '2 days', now() - (i * interval '1 minute'), '${tenant}'
           from generate_series(${from}, ${from} + 101) as i`,
      );
    await groups('shop', A, 1000);
    await groups('blog', B, 2000);
    expect(await prune(store, 'reporting_prune_open_errors(100, 5000)')).toBe(2);
    expect(
      await store.rows(
        'select site, count(*)::int as n from reporting_errors group by site order by site',
      ),
    ).toEqual([
      { site: 'blog', n: 102 },
      { site: 'shop', n: 100 },
    ]);
  });
});

/** Extra, not the proof: the same binding on a real Postgres, as a role this test makes. */
describe.skipIf(!process.env.TEST_DATABASE_URL)('real Postgres: a runtime role is bound', () => {
  let fixture: Awaited<ReturnType<typeof migratedSchema>>;
  const role = `rls_rt_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

  beforeAll(async () => {
    fixture = await migratedSchema('rls_test');
    const q = (text: string) => fixture.admin.query(text);
    await q(`create role ${role} nologin`);
    await q(`grant usage on schema ${fixture.schema} to ${role}`);
    await q(`grant select on ${fixture.schema}.reporting_events to ${role}`);
    for (const tenant of [A, B, null]) {
      const t = tenant === null ? 'null' : `'${tenant}'`;
      await q(
        `insert into ${fixture.schema}.reporting_events (level, kind, site, message, tenant_id) values ('info', 'a.b', 'shop', 'm', ${t})`,
      );
    }
  });
  afterAll(async () => {
    await fixture.admin.query(`drop owned by ${role}`);
    await fixture.admin.query(`drop role ${role}`);
    await fixture.close();
  });

  it('sees its tenant and the null-tenant rows, and with no setting only the null-tenant rows', async () => {
    const q = (text: string) => fixture.admin.query<{ t: string }>(text);
    const read = `select coalesce(tenant_id::text, 'none') as t from ${fixture.schema}.reporting_events order by 1`;
    try {
      await q('begin');
      await q(`set local role ${role}`);
      await q(`select set_config('app.tenant_id', '${A}', true)`);
      expect((await q(read)).map((r) => r.t)).toEqual([A, 'none'].sort());
    } finally {
      await q('rollback');
    }
    try {
      await q('begin');
      await q(`set local role ${role}`);
      expect((await q(read)).map((r) => r.t)).toEqual(['none']);
    } finally {
      await q('rollback');
    }
  });
});
