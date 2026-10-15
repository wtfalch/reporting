import { timingSafeEqual } from 'node:crypto';
import { and, gte, lt, sql } from 'drizzle-orm';
import { unstable_rethrow } from 'next/navigation';
import { connection } from 'next/server';
import { z } from 'zod';
import { reportingRequests } from '../tables.js';
import type { Db, Reporting } from '../types.js';

const DAY_MS = 86_400_000;
const BASELINE_DAYS = 7;
const MAX_RANGE_MS = 8 * DAY_MS;

export interface ReleaseHealthOptions {
  readonly db: Db;
  readonly reporting: Pick<Reporting, 'site' | 'log'>;
  /** Defaults to `process.env.REPORTING_HEALTH_TOKEN`, read on each request. */
  readonly token?: () => string | undefined;
}

const iso = z.iso.datetime({ offset: true });

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

/**
 * `GET /api/reporting/release-health?from=<ISO>&to=<ISO>`: the counts foundry
 * judges a new color by. Request and 5xx totals per color over [from, to),
 * and the per-day average of the seven days before `from`. Counts only; no
 * event, error or request content is read. Bearer token from
 * `REPORTING_HEALTH_TOKEN`: unset is 503, missing or wrong is 401.
 */
export function releaseHealthHandler(options: ReleaseHealthOptions) {
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

    try {
      const sums = {
        requests: sql<string>`coalesce(sum(${reportingRequests.requests}), 0)`,
        errors: sql<string>`coalesce(sum(${reportingRequests.errors}), 0)`,
      };
      const inSite = sql`${reportingRequests.site} = ${site}`;
      const byColor = await options.db
        .select({ color: reportingRequests.color, ...sums })
        .from(reportingRequests)
        .where(and(inSite, gte(reportingRequests.bucket, from), lt(reportingRequests.bucket, to)))
        .groupBy(reportingRequests.color);
      const baselineFrom = new Date(from.getTime() - BASELINE_DAYS * DAY_MS);
      const [baseline] = await options.db
        .select(sums)
        .from(reportingRequests)
        .where(
          and(
            inSite,
            gte(reportingRequests.bucket, baselineFrom),
            lt(reportingRequests.bucket, from),
          ),
        );

      const colors = {
        blue: { requests: 0, errors: 0 },
        green: { requests: 0, errors: 0 },
      };
      for (const row of byColor) {
        if (row.color === 'blue' || row.color === 'green') {
          colors[row.color] = { requests: Number(row.requests), errors: Number(row.errors) };
        }
      }
      return json(
        {
          colors,
          daily: {
            days: BASELINE_DAYS,
            requestsPerDay: Number(baseline?.requests ?? 0) / BASELINE_DAYS,
            errorsPerDay: Number(baseline?.errors ?? 0) / BASELINE_DAYS,
          },
          from: from.toISOString(),
          to: to.toISOString(),
        },
        200,
      );
    } catch (error) {
      options.reporting.log.error(
        { err: error instanceof Error ? error.name : 'unknown' },
        'reporting: release health read failed',
      );
      return json({ error: 'read failed' }, 500);
    }
  };
}

// Any status under 500: the request is counted, and not as an error.
const CONTROL_FLOW_STATUS = 307;

function isNextControlFlow(error: unknown): boolean {
  try {
    unstable_rethrow(error);
    return false;
  } catch {
    // unstable_rethrow throws only for Next's internal control-flow errors.
    return true;
  }
}

/**
 * Wraps a route handler so each response is counted. A handler that throws is
 * counted as a 500 and the throw goes on. Next's own control-flow throws
 * (`redirect()`, `notFound()` and the like) are counted as a request, not an
 * error, so they cannot push a release toward rollback.
 */
export function withRequestCount<A extends unknown[]>(
  reporting: Pick<Reporting, 'requests'>,
  handler: (...args: A) => Promise<Response> | Response,
): (...args: A) => Promise<Response> {
  return async (...args) => {
    try {
      const response = await handler(...args);
      reporting.requests.record(response.status);
      return response;
    } catch (error) {
      reporting.requests.record(isNextControlFlow(error) ? CONTROL_FLOW_STATUS : 500);
      throw error;
    }
  };
}
