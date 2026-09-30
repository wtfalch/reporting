import { sql } from 'drizzle-orm';
import type { Task } from '../housekeeping/index.js';
import { rowsOf } from '../housekeeping/tasks.js';
import type { Db } from '../types.js';

const HOUR = 60 * 60 * 1000;

/**
 * Deletes resolved/ignored error rows past the operator's window, up to
 * twenty batches of 5,000 per run, each in its own statement with a bounded
 * timeout, renewing the lease between batches. `reporting_prune_errors`
 * (0003_errors.sql) does the clamping and, critically, never touches a row
 * still in state 'open' regardless of age.
 *
 * Reuses `events.retention_days` rather than adding an `errors.*` setting: a
 * new setting means a migration to reporting_settings and an operator
 * control nobody asked for. One retention window for the whole operational
 * log (events and the errors grouped from them) is the simpler default.
 */
export const pruneErrors: Task = {
  name: 'reporting.prune_errors',
  every: HOUR,
  lease: 10 * 60 * 1000,
  retry: 15 * 60 * 1000,
  async run(ctx) {
    const days = ctx.settings['events.retention_days'];
    let total = 0;
    for (let i = 0; i < 20; i += 1) {
      if (ctx.now().getTime() > ctx.deadline.getTime() - 30_000) break;
      const n = await pruneErrorsBatch(ctx.db, days, 5000);
      total += n;
      if (n < 5000) break;
      if (!(await ctx.renew())) break;
    }
    if (total > 0) {
      ctx.reporting.event({
        kind: 'reporting.pruned_errors',
        message: `pruned ${total} error(s) older than ${days} days`,
        data: { rows: total, days },
      });
    }
  },
};

export async function pruneErrorsBatch(db: Db, days: number, batch: number): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '30s'`);
    const result = await tx.execute(
      sql`select reporting_prune_errors(make_interval(days => ${days}::int), ${batch}::int) as n`,
    );
    const [row] = rowsOf(result);
    return Number(row?.n ?? 0);
  });
}

/**
 * The most open groups one site keeps. `pruneErrors` never deletes an open
 * group, and the public ingest route lets anyone create one per distinct
 * message, so without this ceiling `reporting_errors` grows without bound.
 * Generous for a real app (a few thousand distinct live bugs is already an
 * incident), tight enough that a flood cannot fill the disk.
 */
export const MAX_OPEN_ERRORS_PER_SITE = 5000;

/**
 * Evicts the least recently seen open groups beyond `MAX_OPEN_ERRORS_PER_SITE`
 * per site (0007_errors_open_cap.sql). Needs that migration; a host that has
 * not applied it sees this one task fail and `pruneErrors` unaffected.
 */
export const pruneOpenErrors: Task = {
  name: 'reporting.prune_open_errors',
  every: HOUR,
  lease: 10 * 60 * 1000,
  retry: 15 * 60 * 1000,
  async run(ctx) {
    let total = 0;
    for (let i = 0; i < 20; i += 1) {
      if (ctx.now().getTime() > ctx.deadline.getTime() - 30_000) break;
      const n = await pruneOpenErrorsBatch(ctx.db, MAX_OPEN_ERRORS_PER_SITE, 5000);
      total += n;
      if (n < 5000) break;
      if (!(await ctx.renew())) break;
    }
    if (total > 0) {
      ctx.reporting.event({
        kind: 'reporting.pruned_open_errors',
        message: `evicted ${total} open error group(s) beyond the per-site cap`,
        data: { rows: total, cap: MAX_OPEN_ERRORS_PER_SITE },
      });
    }
  },
};

export async function pruneOpenErrorsBatch(db: Db, cap: number, batch: number): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '30s'`);
    const result = await tx.execute(
      sql`select reporting_prune_open_errors(${cap}::int, ${batch}::int) as n`,
    );
    const [row] = rowsOf(result);
    return Number(row?.n ?? 0);
  });
}
