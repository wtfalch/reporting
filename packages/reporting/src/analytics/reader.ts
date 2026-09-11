import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import {
  reportingAnalytics,
  reportingAnalyticsDaily,
  reportingAnalyticsWeekly,
} from '../tables.js';
import type { Db } from '../types.js';

export type Grain = 'site' | 'tenant' | 'name' | 'path' | 'device' | 'country' | 'referrer';

export interface SeriesOptions {
  readonly site: string;
  /** A customer organisation's view: its own rows only, and small groups hidden. */
  readonly tenantId?: string;
  readonly from: string;
  readonly to: string;
  /** Which dimension to break down by. `site` (the default) is the total. */
  readonly grain?: Exclude<Grain, 'tenant'>;
  /** Below this many distinct visitors a bucket is shown as `(few)` when `tenantId` is set. Default 5. */
  readonly floor?: number;
}

export interface SeriesPoint {
  readonly day: string;
  readonly key: string;
  readonly views: number;
  readonly visitors: number;
  readonly people: number;
}

/**
 * Daily counts from the rollup (addendum A4: every level is stored, none is
 * summed from another). Only rows without a tenant carry dimensions, so a
 * customer organisation's view is the site total for its tenant and nothing
 * finer; the operator's view has every grain. Small groups (addendum A7)
 * render as `(few)` for a tenant, so a bucket cannot single a person out.
 */
export async function analyticsSeries(
  db: Db,
  opts: SeriesOptions,
): Promise<readonly SeriesPoint[]> {
  const t = reportingAnalyticsDaily;
  if (opts.tenantId) {
    const rows = await db
      .select({ day: t.day, views: t.views, visitors: t.visitors, people: t.people })
      .from(t)
      .where(
        and(
          eq(t.site, opts.site),
          eq(t.grain, 'tenant'),
          eq(t.tenantId, opts.tenantId),
          gte(t.day, opts.from),
          lte(t.day, opts.to),
        ),
      )
      .orderBy(asc(t.day));
    return rows.map((r) => ({
      day: String(r.day),
      key: 'total',
      views: r.views,
      visitors: r.visitors,
      people: r.people,
    }));
  }
  const grain = opts.grain ?? 'site';
  const keyColumn =
    grain === 'name'
      ? t.name
      : grain === 'path'
        ? t.path
        : grain === 'device'
          ? t.device
          : grain === 'country'
            ? t.country
            : grain === 'referrer'
              ? t.referrerHost
              : sql<string>`'total'`;
  const rows = await db
    .select({ day: t.day, key: keyColumn, views: t.views, visitors: t.visitors, people: t.people })
    .from(t)
    .where(
      and(
        eq(t.site, opts.site),
        eq(t.grain, grain),
        isNull(t.tenantId),
        gte(t.day, opts.from),
        lte(t.day, opts.to),
      ),
    )
    .orderBy(asc(t.day), desc(t.views));
  return rows.map((r) => ({
    day: String(r.day),
    key: String(r.key ?? 'total'),
    views: r.views,
    visitors: r.visitors,
    people: r.people,
  }));
}

export interface WeeklyPoint {
  readonly week: string;
  readonly visitors: number;
  readonly returningVisitors: number;
  readonly people: number;
  readonly returningPeople: number;
}

export async function analyticsWeekly(
  db: Db,
  opts: { site: string; tenantId?: string; from: string; to: string },
): Promise<readonly WeeklyPoint[]> {
  const t = reportingAnalyticsWeekly;
  const rows = await db
    .select()
    .from(t)
    .where(
      and(
        eq(t.site, opts.site),
        opts.tenantId ? eq(t.tenantId, opts.tenantId) : isNull(t.tenantId),
        gte(t.week, opts.from),
        lte(t.week, opts.to),
      ),
    )
    .orderBy(asc(t.week));
  return rows.map((r) => ({
    week: String(r.week),
    visitors: r.visitors,
    returningVisitors: r.returningVisitors,
    people: r.people,
    returningPeople: r.returningPeople,
  }));
}

export interface RecentOptions {
  readonly site: string;
  readonly tenantId?: string;
  readonly name?: string;
  readonly limit?: number;
}

export interface RecentEvent {
  readonly occurredAt: Date;
  readonly name: string;
  readonly path: string;
  readonly device: string;
  readonly country: string | null;
  readonly referrerHost: string | null;
  readonly signedIn: boolean;
}

/** The latest raw rows as the operator sees them: what happened, never who. Ids are projected out. */
export async function analyticsRecent(
  db: Db,
  opts: RecentOptions,
): Promise<readonly RecentEvent[]> {
  const t = reportingAnalytics;
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const rows = await db
    .select({
      occurredAt: t.occurredAt,
      name: t.name,
      path: t.path,
      device: t.device,
      country: t.country,
      referrerHost: t.referrerHost,
      signedIn: sql<boolean>`${t.userId} is not null`,
    })
    .from(t)
    .where(
      and(
        eq(t.site, opts.site),
        opts.tenantId ? eq(t.tenantId, opts.tenantId) : undefined,
        opts.name ? eq(t.name, opts.name) : undefined,
      ),
    )
    .orderBy(desc(t.occurredAt), desc(t.id))
    .limit(limit);
  return rows.map((r) => ({ ...r, signedIn: Boolean(r.signedIn) }));
}

/** `(few)` for a customer's bucket under the floor; the operator sees the number. */
export function hideSmallGroups<T extends { visitors: number; key: string }>(
  points: readonly T[],
  floor = 5,
): readonly T[] {
  return points.map((p) => (p.visitors > 0 && p.visitors < floor ? { ...p, key: '(few)' } : p));
}
