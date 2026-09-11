import { sql } from 'drizzle-orm';
import { reportingEvents } from '../tables.js';
import type { Db } from '../types.js';
import type { Task } from './index.js';

/** `db.execute` returns an array on postgres-js and `{ rows }` on PGlite; this reads either. */
export function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const r = result as { rows?: unknown };
  return Array.isArray(r?.rows) ? (r.rows as Record<string, unknown>[]) : [];
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Deletes rows older than the operator's window, up to twenty batches of
 * 5,000 per run, each in its own statement with a bounded timeout, renewing
 * the lease between batches. The function clamps the window itself, so a
 * setting of one day still keeps a week.
 */
export const pruneEvents: Task = {
  name: 'reporting.prune_events',
  every: HOUR,
  lease: 10 * 60 * 1000,
  retry: 15 * 60 * 1000,
  async run(ctx) {
    const days = ctx.settings['events.retention_days'];
    let total = 0;
    for (let i = 0; i < 20; i += 1) {
      if (ctx.now().getTime() > ctx.deadline.getTime() - 30_000) break;
      const n = await pruneBatch(ctx.db, days, 5000);
      total += n;
      if (n < 5000) break;
      if (!(await ctx.renew())) break;
    }
    if (total > 0) {
      ctx.reporting.event({
        kind: 'reporting.pruned',
        message: `pruned ${total} event(s) older than ${days} days`,
        data: { rows: total, days },
      });
    }
  },
};

export async function pruneBatch(db: Db, days: number, batch: number): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '30s'`);
    const result = await tx.execute(
      sql`select reporting_prune_events(make_interval(days => ${days}::int), ${batch}::int) as n`,
    );
    const [row] = rowsOf(result);
    return Number(row?.n ?? 0);
  });
}

/**
 * The watchdog on the promise prune makes: if the oldest row is older than
 * one and a half windows, prune has not been running and somebody should
 * know. It shares the tick's failure domain and cannot report a tick that
 * is entirely down; it catches the case where the tick runs and prune
 * keeps failing or never gets claimed.
 */
export const retentionLag: Task = {
  name: 'reporting.retention_lag',
  every: DAY,
  lease: 60 * 1000,
  retry: HOUR,
  async run(ctx) {
    const days = ctx.settings['events.retention_days'];
    const [row] = await ctx.db
      .select({ oldest: sql<Date | string | null>`min(${reportingEvents.occurredAt})` })
      .from(reportingEvents);
    const oldest = row?.oldest ? new Date(row.oldest) : null;
    if (!oldest) return;
    const lagDays = (ctx.now().getTime() - oldest.getTime()) / DAY;
    if (lagDays > days * 1.5) {
      ctx.reporting.alert({
        check: 'retention_lag',
        message: `the oldest event is ${Math.floor(lagDays)} days old against a ${days}-day window; prune is not keeping up`,
        detail: { oldestDays: Math.floor(lagDays), windowDays: days },
      });
    }
  },
};
