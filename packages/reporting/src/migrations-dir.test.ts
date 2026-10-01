import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { runMigrationSources } from '@wtfalch/db/migrate';
import { createPgliteDatabase } from '@wtfalch/db/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import * as main from './index.js';
import { migrationsDir } from './migrations-dir.js';
import { tables } from './tables.js';
import { memoryLog } from './test/db.js';

describe('migrationsDir', () => {
  it('lists every .sql file, is its own subpath, and is not in the main entry', () => {
    expect(readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).length).toBeGreaterThan(0);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, { default: string }>;
    };
    expect(pkg.exports['./migrations-dir']?.default).toBe('./dist/migrations-dir.js');
    expect(pkg.exports['./migrations/*.sql']).toBeDefined();
    expect('migrationsDir' in main).toBe(false);
  });
});

// The default tier runs the SQL in a named schema, the way a service host does.
describe('migrations in a named schema', () => {
  let pglite: PGlite;
  afterEach(async () => {
    await pglite.close();
  });

  it('creates the tables and functions in the schema, not in public, and writes and reads on a schema-only search_path', async () => {
    pglite = new PGlite();
    const owner = createPgliteDatabase(pglite);
    await runMigrationSources({
      owner,
      schema: 'svc',
      sources: [{ name: 'reporting', dir: migrationsDir }],
      log: () => undefined,
    });

    const where = await pglite.query<{ table_schema: string }>(
      "select distinct table_schema from information_schema.tables where table_name like 'reporting\\_%'",
    );
    expect(where.rows.map((row) => row.table_schema)).toEqual(['svc']);
    const fns = await pglite.query<{ nspname: string }>(
      "select distinct n.nspname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname like 'reporting\\_%'",
    );
    expect(fns.rows.map((row) => row.nspname)).toEqual(['svc']);

    // The runner restores the owner's search_path; a runtime connection sets its own.
    await pglite.exec('set search_path to svc');
    const reporting = main.createReporting({
      db: drizzle(pglite, { schema: tables }),
      log: memoryLog(),
      site: 'test',
      mode: 'test',
      defer: () => {},
    });
    reporting.event({ kind: 'a.b', message: 'hello' });
    await reporting.flush();
    expect((await reporting.events.page({})).items.map((r) => r.message)).toEqual(['hello']);
    // A definer function finds its table through the schema it was created in.
    await pglite.exec("update svc.reporting_events set occurred_at = now() - interval '100 days'");
    const pruned = await pglite.query<{ n: number }>(
      "select reporting_prune_events(interval '30 days', 10) as n",
    );
    expect(pruned.rows[0]?.n).toBe(1);
  });
});
