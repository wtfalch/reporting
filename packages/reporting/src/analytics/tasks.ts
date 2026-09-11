import { sql } from 'drizzle-orm';
import type { Task, TaskContext } from '../housekeeping/index.js';
import { rowsOf } from '../housekeeping/tasks.js';
import type { Db } from '../types.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Completed days rolled up per run, so a long outage catches up in bounded steps under a renewed lease. */
const CATCH_UP_DAYS = 14;
/** The weekly rollup's raw lookback: returning means seen in one of the four weeks before. */
export const WEEKLY_LOOKBACK_DAYS = 28;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
/** The Monday of the ISO week holding `d`, at UTC midnight. */
export const mondayOf = (d: Date) => {
  const day = utcDay(d);
  const dow = (day.getUTCDay() + 6) % 7;
  return addDays(day, -dow);
};

async function rollupDay(db: Db, day: string): Promise<number> {
  const result = await db.execute(sql`select reporting_rollup_day(${day}::date) as n`);
  return Number(rowsOf(result)[0]?.n ?? 0);
}
async function rollupWeek(db: Db, monday: string): Promise<number> {
  const result = await db.execute(sql`select reporting_rollup_week(${monday}::date) as n`);
  return Number(rowsOf(result)[0]?.n ?? 0);
}

/** The first day worth rolling up when there is no watermark yet: the oldest raw row's day, or nothing. */
async function firstRawDay(db: Db): Promise<string | null> {
  const result = await db.execute(
    sql`select min((occurred_at at time zone 'UTC')::date)::text as d from reporting_analytics`,
  );
  const d = rowsOf(result)[0]?.d;
  return typeof d === 'string' && d.length === 10 ? d : null;
}

/**
 * The daily rollup (addendum A3). Completed days first: from the day after
 * the watermark up to yesterday, each day's aggregate set and the watermark
 * move committed together, fenced by the claim token, in bounded batches
 * with the lease renewed between them. Then the open day (today) is
 * recomputed without moving the watermark, so the dashboard is current and
 * history stays contiguous.
 */
export const rollupAnalytics: Task = {
  name: 'reporting.rollup_analytics',
  every: HOUR,
  lease: 10 * 60 * 1000,
  retry: 15 * 60 * 1000,
  async run(ctx) {
    const today = utcDay(ctx.now());
    const yesterday = addDays(today, -1);
    let cursor = ctx.watermark ? addDays(new Date(`${ctx.watermark}T00:00:00Z`), 1) : null;
    if (!cursor) {
      const first = await firstRawDay(ctx.db);
      cursor = first ? new Date(`${first}T00:00:00Z`) : null;
    }
    let completed = 0;
    while (cursor && cursor.getTime() <= yesterday.getTime() && completed < CATCH_UP_DAYS) {
      if (ctx.now().getTime() > ctx.deadline.getTime() - 60_000) break;
      const day = iso(cursor);
      const moved = await ctx.db.transaction(async (tx) => {
        await rollupDay(tx, day);
        return ctx.commitWatermark(day, tx);
      });
      if (!moved) {
        // The lease went to another process; its run owns the watermark now.
        ctx.reporting.event({
          kind: 'reporting.rollup_yielded',
          level: 'warn',
          message: `rollup of ${day} yielded: the lease was lost before the watermark moved`,
          data: { day },
        });
        return;
      }
      completed += 1;
      cursor = addDays(cursor, 1);
      if (!(await ctx.renew())) return;
    }
    // The open day, and yesterday if the catch-up has not reached it yet:
    // recomputed for the dashboard, never vouched for.
    const openFrom = cursor && cursor.getTime() < today.getTime() ? cursor : today;
    for (let d = openFrom; d.getTime() <= today.getTime(); d = addDays(d, 1)) {
      await rollupDay(ctx.db, iso(d));
    }
    if (completed > 0) {
      ctx.reporting.event({
        kind: 'reporting.rolled_up',
        message: `rolled up ${completed} completed day(s), watermark ${iso(addDays(cursor ?? today, -1))}`,
        data: { days: completed, watermark: iso(addDays(cursor ?? today, -1)) },
      });
    }
  },
};

/**
 * The weekly rollup: completed ISO weeks (Monday to Sunday, wholly before
 * today) from the week after its own watermark, then the open week
 * recomputed. Its watermark is the Monday of the last completed week.
 */
export const rollupAnalyticsWeekly: Task = {
  name: 'reporting.rollup_analytics_weekly',
  every: DAY,
  lease: 10 * 60 * 1000,
  retry: HOUR,
  async run(ctx) {
    const today = utcDay(ctx.now());
    const thisMonday = mondayOf(today);
    let cursor: Date | null = ctx.watermark
      ? addDays(new Date(`${ctx.watermark}T00:00:00Z`), 7)
      : null;
    if (!cursor) {
      const first = await firstRawDay(ctx.db);
      cursor = first ? mondayOf(new Date(`${first}T00:00:00Z`)) : null;
    }
    let completed = 0;
    while (cursor && cursor.getTime() < thisMonday.getTime() && completed < 26) {
      if (ctx.now().getTime() > ctx.deadline.getTime() - 60_000) break;
      const monday = iso(cursor);
      const moved = await ctx.db.transaction(async (tx) => {
        await rollupWeek(tx, monday);
        return ctx.commitWatermark(monday, tx);
      });
      if (!moved) return;
      completed += 1;
      cursor = addDays(cursor, 7);
      if (!(await ctx.renew())) return;
    }
    await rollupWeek(ctx.db, iso(thisMonday));
  },
};

/**
 * Raw rows leave by age, and never past what the rollups still need: the
 * daily watermark, and the weekly watermark less its lookback, whichever is
 * earlier. Until both rollups have completed a day there is nothing safe to
 * prune, and the function says so.
 */
export const pruneAnalytics: Task = {
  name: 'reporting.prune_analytics',
  every: HOUR,
  lease: 10 * 60 * 1000,
  retry: 15 * 60 * 1000,
  async run(ctx) {
    const days = ctx.settings['analytics.retention_days'];
    const safeBefore = await safePruneBoundary(ctx.db);
    if (!safeBefore) return;
    // The window's cutoff must fall before what the rollups still need. A
    // window shorter than that (an operator's edit against a stalled
    // rollup, or one shorter than the weekly lookback) defers pruning with
    // a warning rather than failing every hour; the function refuses too.
    const cutoffDay = iso(addDays(utcDay(ctx.now()), -days));
    if (cutoffDay >= safeBefore) {
      ctx.reporting.event({
        kind: 'reporting.prune_deferred',
        level: 'warn',
        message: `analytics pruning deferred: a ${days}-day window would cut at ${cutoffDay}, but the rollups still need raw rows from ${safeBefore}`,
        data: { days, cutoffDay, safeBefore },
      });
      return;
    }
    let total = 0;
    for (let i = 0; i < 20; i += 1) {
      if (ctx.now().getTime() > ctx.deadline.getTime() - 30_000) break;
      const n = await pruneAnalyticsBatch(ctx.db, days, 5000, safeBefore);
      total += n;
      if (n < 5000) break;
      if (!(await ctx.renew())) break;
    }
    if (total > 0) {
      ctx.reporting.event({
        kind: 'reporting.pruned_analytics',
        message: `pruned ${total} analytics row(s) older than ${days} days`,
        data: { rows: total, days, safeBefore },
      });
    }
  },
};

/** The earliest day the rollups still need, as an ISO date, or null when a rollup has not completed anything yet. */
export async function safePruneBoundary(db: Db): Promise<string | null> {
  const result = await db.execute(
    sql`select task, watermark from reporting_tasks where task in ('reporting.rollup_analytics', 'reporting.rollup_analytics_weekly')`,
  );
  const marks = new Map(rowsOf(result).map((r) => [String(r.task), r.watermark]));
  const daily = marks.get('reporting.rollup_analytics');
  const weekly = marks.get('reporting.rollup_analytics_weekly');
  if (typeof daily !== 'string' || typeof weekly !== 'string') return null;
  const weeklyNeeds = addDays(new Date(`${weekly}T00:00:00Z`), -WEEKLY_LOOKBACK_DAYS);
  const dailyDate = new Date(`${daily}T00:00:00Z`);
  return iso(weeklyNeeds.getTime() < dailyDate.getTime() ? weeklyNeeds : dailyDate);
}

export async function pruneAnalyticsBatch(
  db: Db,
  days: number,
  batch: number,
  safeBefore: string,
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '30s'`);
    const result = await tx.execute(
      sql`select reporting_prune_analytics(make_interval(days => ${days}::int), ${batch}::int, ${safeBefore}::date) as n`,
    );
    return Number(rowsOf(result)[0]?.n ?? 0);
  });
}

export type { TaskContext };
