import { type AnyColumn, and, gte, lt, sql } from 'drizzle-orm';
import { connection } from 'next/server';
import { reportingRequests } from '../tables.js';
import {
  MAX_RANGE_MS,
  type ReleaseHealthOptions,
  iso,
  json,
  tokenMatches,
} from './release-health.js';

export type ReleaseSeriesOptions = ReleaseHealthOptions;

const BUCKET_MINUTES = [10, 20, 60];
const DEFAULT_BUCKET_MINUTES = 20;

interface ColorCounts {
  requests: number;
  errors: number;
  slow: number;
  durationMsSum: number;
  signIns: number;
  signInFailures: number;
}

const zero = (): ColorCounts => ({
  requests: 0,
  errors: 0,
  slow: 0,
  durationMsSum: 0,
  signIns: 0,
  signInFailures: 0,
});

/**
 * `GET /api/reporting/release-series?from=<ISO>&to=<ISO>&bucket=<10|20|60>`:
 * the per-minute counts of `reporting_requests` summed into buckets of
 * `bucket` minutes (default 20), per color. Buckets start at `from` and run
 * to `to`, so the first bucket starts exactly at `from`; the last may be
 * shorter. Every bucket in the range is present, with zeros where nothing was
 * counted. Counts only. Same bearer token and span limit (8 days) as
 * `releaseHealthHandler`: unset token is 503, missing or wrong is 401, bad
 * `from`, `to` or `bucket` is 400. Not counted as traffic (see
 * `DEFAULT_UNCOUNTED_PATHS`).
 */
export function releaseSeriesHandler(options: ReleaseSeriesOptions) {
  const token = options.token ?? (() => process.env.REPORTING_HEALTH_TOKEN);
  const site = options.reporting.site;
  return async (request: Request): Promise<Response> => {
    await connection();
    const expected = token();
    if (!expected) return json({ error: 'not configured' }, 503);
    const header = request.headers.get('authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match?.[1] || !tokenMatches(match[1], expected)) {
      return json({ error: 'unauthorized' }, 401);
    }

    const params = new URL(request.url).searchParams;
    const fromRaw = iso.safeParse(params.get('from'));
    const toRaw = iso.safeParse(params.get('to'));
    if (!fromRaw.success || !toRaw.success) {
      return json({ error: 'from and to must be ISO timestamps' }, 400);
    }
    const from = new Date(fromRaw.data);
    const to = new Date(toRaw.data);
    if (!(from.getTime() < to.getTime()) || to.getTime() - from.getTime() > MAX_RANGE_MS) {
      return json({ error: 'from must be before to, at most 8 days apart' }, 400);
    }
    const bucketRaw = params.get('bucket');
    const bucketMinutes = bucketRaw === null ? DEFAULT_BUCKET_MINUTES : Number(bucketRaw);
    if (!BUCKET_MINUTES.includes(bucketMinutes)) {
      return json({ error: 'bucket must be 10, 20 or 60' }, 400);
    }

    const bucketMs = bucketMinutes * 60_000;
    try {
      const index = sql<number>`floor((extract(epoch from ${reportingRequests.bucket}) * 1000 - ${from.getTime()}::numeric) / ${bucketMs}::numeric)::int`;
      const sum = (c: AnyColumn) => sql<string>`coalesce(sum(${c}), 0)`;
      const rows = await options.db
        .select({
          index,
          color: reportingRequests.color,
          requests: sum(reportingRequests.requests),
          errors: sum(reportingRequests.errors),
          slow: sum(reportingRequests.slow),
          durationMsSum: sum(reportingRequests.durationMsSum),
          signIns: sum(reportingRequests.signIns),
          signInFailures: sum(reportingRequests.signInFailures),
        })
        .from(reportingRequests)
        .where(
          and(
            sql`${reportingRequests.site} = ${site}`,
            gte(reportingRequests.bucket, from),
            lt(reportingRequests.bucket, to),
          ),
        )
        .groupBy(sql`1`, sql`2`);

      const count = Math.ceil((to.getTime() - from.getTime()) / bucketMs);
      const buckets = Array.from({ length: count }, (_, i) => ({
        start: new Date(from.getTime() + i * bucketMs).toISOString(),
        colors: { blue: zero(), green: zero() },
      }));
      for (const row of rows) {
        const bucket = buckets[Number(row.index)];
        if (!bucket || (row.color !== 'blue' && row.color !== 'green')) continue;
        bucket.colors[row.color] = {
          requests: Number(row.requests),
          errors: Number(row.errors),
          slow: Number(row.slow),
          durationMsSum: Number(row.durationMsSum),
          signIns: Number(row.signIns),
          signInFailures: Number(row.signInFailures),
        };
      }
      return json({ bucketMinutes, buckets }, 200);
    } catch (error) {
      options.reporting.log.error(
        { err: error instanceof Error ? error.name : 'unknown' },
        'reporting: release series read failed',
      );
      return json({ error: 'read failed' }, 500);
    }
  };
}
