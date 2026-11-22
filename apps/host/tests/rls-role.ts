/** What a test needs of the store: one statement at a time, on the one connection. */
export type Rows = (text: string) => Promise<Record<string, unknown>[]>;

/** The tables the runtime role may not update: the log is append-only. */
const INSERT_ONLY = ['reporting_events', 'audit_events'];

/** A uuid literal checked before it reaches SQL text. */
function uuid(value: string): string {
  if (!/^[0-9a-f-]{36}$/.test(value)) throw new Error('not a uuid');
  return value;
}

/**
 * As the superuser, makes the two roles production's split is meant to have
 * and a schema the policies bind: `owner_r` owns every base table and every
 * definer function of the schema (neither superuser nor BYPASSRLS, so FORCE
 * binds it), and `rt` is the runtime role with the grants the host gives it.
 * Run once per store.
 */
export async function createRlsRoles(rows: Rows): Promise<void> {
  for (const role of ['owner_r', 'rt']) {
    await rows(`create role ${role} nologin nosuperuser nobypassrls`);
  }
  await rows(`do $$ declare r record; begin
    for r in select tablename from pg_tables where schemaname = current_schema() loop
      execute format('alter table %I owner to owner_r', r.tablename);
    end loop;
    for r in select p.oid::regprocedure::text as signature from pg_proc p
      where p.pronamespace = current_schema()::regnamespace and p.prosecdef loop
      execute format('alter function %s owner to owner_r', r.signature);
    end loop;
  end $$`);
  await rows('grant usage on schema public to rt');
  await rows('grant select, insert, update on all tables in schema public to rt');
  await rows(`revoke update on ${INSERT_ONLY.join(', ')} from rt`);
  for (const signature of [
    'reporting_prune_events(interval, integer)',
    'reporting_prune_errors(interval, integer)',
    'reporting_prune_open_errors(integer, integer)',
  ]) {
    await rows(`grant execute on function ${signature} to rt`);
  }
}

/**
 * Runs `work` as `rt`, bound to `tenant` (or to none), in a transaction that
 * is always rolled back. PGlite has one connection and a session-level SET
 * ROLE sticks, so the role is reset in a `finally`.
 */
export async function asRuntime<T>(
  rows: Rows,
  tenant: string | null,
  work: () => Promise<T>,
): Promise<T> {
  await rows('begin');
  try {
    await rows('set local role rt');
    if (tenant !== null) await rows(`select set_config('app.tenant_id', '${uuid(tenant)}', true)`);
    return await work();
  } finally {
    await rows('rollback');
    await rows('reset role');
  }
}
