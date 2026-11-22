import type { Db } from '@wtfalch/reporting-core';
import { sql } from 'drizzle-orm';

/** The transaction handle `Db.transaction` gives its callback. */
type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];

declare const bound: unique symbol;

/**
 * A database handle whose transaction has set `app.tenant_id`. Only
 * `inTenant` produces one, so a function that takes it cannot be called with
 * a bare `Db`: under forced row-level security that handle would read as empty.
 */
export type TenantDb = Transaction & { readonly [bound]: true };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `work` in a transaction whose first statement binds it to `tenantId`:
 * `set_config('app.tenant_id', id, true)`, local to the transaction, so a
 * pooled connection never carries the setting out. The id is checked before
 * any SQL. Called with a handle that is already in a transaction it opens a
 * savepoint and sets the same value again.
 */
export async function inTenant<T>(
  db: Pick<Db, 'transaction'>,
  tenantId: string,
  work: (tx: TenantDb) => Promise<T>,
): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error('inTenant: the tenant id must be a UUID');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return work(tx as TenantDb);
  });
}

/**
 * A savepoint inside a bound transaction, for work that must commit or roll
 * back as one unit (a change and its audit row). The setting is already in
 * place, so the handle it gives is bound too. Not exported from the package.
 */
export function savepoint<T>(db: TenantDb, work: (tx: TenantDb) => Promise<T>): Promise<T> {
  return db.transaction((tx) => work(tx as TenantDb));
}
