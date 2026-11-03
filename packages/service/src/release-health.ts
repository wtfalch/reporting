import type { Db, Logger } from '@wtfalch/reporting-core';
import { reportingRequests } from '@wtfalch/reporting-core';
import { and, gte, lt, sql } from 'drizzle-orm';
import { errorResponse, handle, json, requirePermission } from './http.js';
import type { ReportingPrincipal } from './principal.js';

export interface CreateReleaseHealthHandlerOptions {
  readonly db: Db;
  readonly site: string;
  readonly log: Logger;
  readonly principal: ReportingPrincipal | null;
}

const DAY_MS = 86_400_000;
const BASELINE_DAYS = 7;
const MAX_RANGE_MS = 8 * DAY_MS;

/**
 * The counts foundry judges a new color by: request and 5xx totals per
 * color over `[from, to)`, and the per-day average of the seven days
 * before `from`. Counts only -- no event, error or request content is
 * read. The same query `next/release-health.ts` runs for a company app
 * that reaches it directly over Next; this is its handler-factory
 * counterpart for the data service, gated by `reporting:release-health`
 * instead of that route's own bearer token (the data service host already
 * verified the caller before this is reached).
 */
export function createReleaseHealthHandler(options: CreateReleaseHealthHandlerOptions) {
  return (request: Request): Promise<Response> =>
    handle(async () => {
      if (request.method !== 'GET') return errorResponse('not_found', 'Route not found');
      requirePermission(options.principal, 'reporting:release-health');
      const params = new URL(request.url).searchParams;
      const fromRaw = params.get('from');
      const toRaw = params.get('to');
      const from = fromRaw ? new Date(fromRaw) : null;
      const to = toRaw ? new Date(toRaw) : null;
      if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return errorResponse('invalid_request', 'from and to must be ISO timestamps');
      }
      if (!(from.getTime() < to.getTime()) || to.getTime() - from.getTime() > MAX_RANGE_MS) {
        return errorResponse('invalid_request', 'from must be before to, at most 8 days apart');
      }

      try {
        const sums = {
          requests: sql<string>`coalesce(sum(${reportingRequests.requests}), 0)`,
          errors: sql<string>`coalesce(sum(${reportingRequests.errors}), 0)`,
        };
        const inSite = sql`${reportingRequests.site} = ${options.site}`;
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
        return json({
          colors,
          daily: {
            days: BASELINE_DAYS,
            requestsPerDay: Number(baseline?.requests ?? 0) / BASELINE_DAYS,
            errorsPerDay: Number(baseline?.errors ?? 0) / BASELINE_DAYS,
          },
          from: from.toISOString(),
          to: to.toISOString(),
        });
      } catch (error) {
        options.log.error(
          { err: error instanceof Error ? error.name : 'unknown' },
          'reporting: release health read failed',
        );
        return errorResponse('unavailable', 'Read failed');
      }
    });
}
