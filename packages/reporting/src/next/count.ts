import type { Reporting } from '../types.js';

/**
 * Counting for every request, with no change per route. Two halves, because
 * Next gives each half only part of the picture:
 *
 * - `countRequests` wraps the app's `proxy.ts` function. It runs on every
 *   matched request before the page or route, so it counts the request. It
 *   sees the status the proxy itself answers with (a redirect, a 403, a 500
 *   from its own throw); a request it lets through is a pass-through there,
 *   and the page's real status is not known yet.
 * - `countRequestErrors` is `onRequestError` in `instrumentation.ts`. Next calls
 *   it for each error a page, route handler or Server Action throws, which is
 *   the 5xx; it adds an error to a request the proxy already counted.
 *
 * Runtime: in Next 16 `proxy.ts` runs on the Node runtime only (Edge is not
 * supported there), and `onRequestError` runs in whichever runtime threw. The
 * counter is an in-memory map flushed to Postgres, so it works in Node. In an
 * Edge runtime the call is skipped (see `isEdge`): an Edge instance has no
 * database and its own memory, so a count there would never be written.
 *
 * Do not also wrap a route in `withRequestCount` when the proxy matcher
 * covers it: the request would be counted twice, and a throw as two errors.
 * `withRequestCount` stays for a path the proxy matcher excludes.
 *
 * Neither function ever fails a request: a counting error is logged.
 */

/** The probe and the release-health read are not traffic; counting them would swamp the signal. */
export const DEFAULT_UNCOUNTED_PATHS: readonly string[] = [
  '/api/health',
  '/api/reporting/release-health',
];

export interface CountOptions {
  /** Paths (exact, or a prefix followed by `/`) that are not counted. Replaces the default list. */
  readonly skipPaths?: readonly string[];
}

const isEdge = (): boolean => process.env.NEXT_RUNTIME === 'edge';

function isSkipped(pathname: string, skip: readonly string[]): boolean {
  return skip.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    // A request path (`/x?y=1`) rather than a full URL, as onRequestError hands over.
    return url.split('?')[0] ?? url;
  }
}

function safely(reporting: Pick<Reporting, 'log'>, what: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    try {
      reporting.log.error(
        { err: error instanceof Error ? error.name : 'unknown' },
        `reporting: ${what} failed`,
      );
    } catch (logError) {
      // The logger itself threw; counting must still never fail a request.
      console.error(`reporting: ${what} failed and so did the logger`, logError);
    }
  }
}

/**
 * Wraps the app's proxy function: `export const proxy = countRequests(reporting, handler)`.
 * Counts the status the proxy answers with; a throw counts as a 500 and goes on.
 */
export function countRequests<A extends { url: string }, R extends { status: number } | undefined>(
  reporting: Pick<Reporting, 'requests' | 'log'>,
  handler: (request: A) => Promise<R> | R,
  options: CountOptions = {},
): (request: A) => Promise<R> {
  const skip = options.skipPaths ?? DEFAULT_UNCOUNTED_PATHS;
  const count = (request: A, status: number) =>
    safely(reporting, 'request count', () => {
      if (isEdge() || isSkipped(pathnameOf(request.url), skip)) return;
      reporting.requests.record(status);
    });
  return async (request) => {
    let response: R;
    try {
      response = await handler(request);
    } catch (error) {
      count(request, 500);
      throw error;
    }
    count(request, response?.status ?? 200);
    return response;
  };
}

type RequestErrorArgs = Parameters<import('./index.js').NextOnRequestError>;

/**
 * `export const onRequestError = countRequestErrors(reporting)`. Pass the
 * handler you already export (Sentry's, `errorHandler(reporting)`) as `next`
 * and it still runs, after the count and whatever the count does.
 */
export function countRequestErrors(
  reporting: Pick<Reporting, 'requests' | 'log'>,
  next?: (...args: RequestErrorArgs) => void | Promise<void>,
  options: CountOptions = {},
): (...args: RequestErrorArgs) => void | Promise<void> {
  const skip = options.skipPaths ?? DEFAULT_UNCOUNTED_PATHS;
  return (...args) => {
    safely(reporting, 'request error count', () => {
      // A throw in the proxy is already counted by `countRequests` as a 500; Next also reports it here.
      if (args[2].routeType === 'proxy') return;
      if (isEdge() || isSkipped(pathnameOf(args[1].path), skip)) return;
      reporting.requests.recordError();
    });
    return next?.(...args);
  };
}
