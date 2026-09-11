import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATION_SQL } from './test/db.js';

/**
 * The runtime-role convention, on a real Postgres only: a role named
 * <database>_rt that the host's first migration created with the estate's
 * default privileges. The package's migration must leave that role able to
 * write events and edit tasks and settings, unable to update or delete an
 * event, and able to run the prune function, which `public` cannot.
 *
 * This file stands in for the host's `0001_runtime_role.sql`: it creates the
 * role and the default privileges the same way before applying the package
 * migration, so the revokes have something to revoke.
 */

const URL_ = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_)('the runtime role', () => {
  // Evaluated even when skipped, so tolerate the variable being absent.
  const url = URL_ ?? 'postgres://skipped:skipped@localhost/skipped';
  const dbName = new URL(url).pathname.slice(1);
  const rt = `${dbName}_rt`;
  let owner: ReturnType<typeof postgres>;
  let runtime: ReturnType<typeof postgres>;

  beforeAll(async () => {
    owner = postgres(url, { prepare: false, max: 2 });
    await owner.unsafe('drop schema public cascade; create schema public;');
    await owner.unsafe(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = '${rt}') then
          execute format('create role %I login nosuperuser nobypassrls password ''rt''', '${rt}');
        end if;
      end $$;
      grant usage on schema public to "${rt}";
      alter default privileges in schema public grant select, insert, update, delete on tables to "${rt}";
      alter default privileges in schema public grant usage, select on sequences to "${rt}";
    `);
    await owner.unsafe(MIGRATION_SQL);
    const u = new URL(url);
    u.username = rt;
    u.password = 'rt';
    runtime = postgres(u.toString(), { prepare: false, max: 2 });
  });
  afterAll(async () => {
    await runtime?.end();
    await owner?.end();
  });

  it('can insert and read events, cannot update, delete or truncate them', async () => {
    await runtime.unsafe(
      `insert into reporting_events (level, kind, site, message) values ('info', 'a.b', 'test', 'm')`,
    );
    const rows = await runtime.unsafe('select count(*)::int as n from reporting_events');
    expect(Number(rows[0]?.n)).toBe(1);
    await expect(runtime.unsafe(`update reporting_events set message = 'x'`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(runtime.unsafe('delete from reporting_events')).rejects.toThrow(
      /permission denied/,
    );
    await expect(runtime.unsafe('truncate reporting_events')).rejects.toThrow(/permission denied/);
  });

  it('can claim tasks and edit settings, cannot delete either', async () => {
    await runtime.unsafe(`insert into reporting_tasks (task) values ('a.b')`);
    await runtime.unsafe(
      `update reporting_tasks set claim_token = gen_random_uuid() where task = 'a.b'`,
    );
    await runtime.unsafe(
      `insert into reporting_settings (key, value) values ('events.retention_days', '30')`,
    );
    await runtime.unsafe(
      `update reporting_settings set value = '45' where key = 'events.retention_days'`,
    );
    await expect(runtime.unsafe('delete from reporting_tasks')).rejects.toThrow(
      /permission denied/,
    );
    await expect(runtime.unsafe('delete from reporting_settings')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('can run the prune function; public cannot', async () => {
    await owner.unsafe(`update reporting_events set occurred_at = now() - interval '100 days'`);
    const rows = await runtime.unsafe(
      `select reporting_prune_events(interval '30 days', 100) as n`,
    );
    expect(Number(rows[0]?.n)).toBe(1);
    const acl = await owner.unsafe(
      `select has_function_privilege('${rt}', 'reporting_prune_events(interval, integer)', 'execute') as rt,
              has_function_privilege('public', 'reporting_prune_events(interval, integer)', 'execute') as pub`,
    );
    expect(acl[0]).toMatchObject({ rt: true, pub: false });
  });

  it('the drizzle handle over the runtime role behaves the same', async () => {
    const db = drizzle(runtime);
    await expect(db.execute('delete from reporting_events' as never)).rejects.toThrow();
  });
});
