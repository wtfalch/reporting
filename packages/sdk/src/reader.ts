import { ReportingApiError, createTransport } from './transport.js';
import type {
  ErrorGroup,
  ErrorSeries,
  ErrorSeriesOptions,
  ErrorsPage,
  GetErrorOptions,
  ListErrorsOptions,
  SetErrorStateInput,
} from './types.js';

export interface ErrorReaderOptions {
  /** The company's reporting backend, `REPORTING_URL`: `https://reporting.<domain>`. */
  url: string;
  /** `REPORTING_OPERATOR_KEY`. Server-side only: it reads every app's errors. */
  operatorKey: string;
  /** Defaults to the global `fetch`; inject one in tests. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds (default 5000). */
  timeoutMs?: number;
}

export interface ErrorReader {
  /** One page of a site's error groups, newest `lastSeenAt` first. */
  list(options: ListErrorsOptions): Promise<ErrorsPage>;
  /** One group. A group that does not exist, or is another site's, rejects with code `not_found`. */
  get(options: GetErrorOptions): Promise<ErrorGroup>;
  /** `resolved` and `ignored` stamp who and when; `open` clears both. Unknown group: `not_found`. */
  setState(input: SetErrorStateInput): Promise<ErrorGroup>;
  /** Occurrences per bucket from `from` to `to` (at most 31 days), every bucket present. */
  series(options: ErrorSeriesOptions): Promise<ErrorSeries>;
}

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(name, String(value));
  }
  return params.toString();
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

const FINGERPRINT = /^[0-9a-f]{32}$/;

/** A fingerprint goes into the request path: anything but its documented 32
 * lower-case hex characters (a `.` or a `..` segment, say) can make `new
 * URL()` resolve the path to a different route than the one named here. */
function checkFingerprint(fingerprint: string): string {
  if (!FINGERPRINT.test(fingerprint)) {
    throw new ReportingApiError(
      0,
      'invalid_request',
      'fingerprint must be 32 lower-case hex characters',
    );
  }
  return fingerprint;
}

/**
 * Reads a company's errors back, for Boule: the operator routes of the
 * contract. Every failure rejects with a `ReportingApiError` carrying the
 * backend's `code` (`unauthorized`, `not_found`, ...), or `unavailable` with
 * status 0 when no answer came within the timeout. Nothing here is cached.
 */
export function createErrorReader(options: ErrorReaderOptions): ErrorReader {
  const call = createTransport({
    url: options.url,
    credential: options.operatorKey,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });
  return {
    list: (o) =>
      call<ErrorsPage>(
        'GET',
        `/v1/errors?${query({
          site: o.site,
          environment: o.environment,
          state: o.state,
          runtime: o.runtime,
          search: o.search,
          limit: o.limit,
          after: o.after,
        })}`,
      ),
    get: async (o) =>
      call<ErrorGroup>(
        'GET',
        `/v1/errors/${encodeURIComponent(checkFingerprint(o.fingerprint))}?${query({ site: o.site })}`,
      ),
    setState: async (input) =>
      call<ErrorGroup>(
        'POST',
        `/v1/errors/${encodeURIComponent(checkFingerprint(input.fingerprint))}/state`,
        {
          site: input.site,
          state: input.state,
          by: { class: input.by.class, id: input.by.id },
        },
      ),
    series: (o) =>
      call<ErrorSeries>(
        'GET',
        `/v1/errors/series?${query({
          site: o.site,
          environment: o.environment,
          from: iso(o.from),
          to: iso(o.to),
          bucket: o.bucket,
          fingerprint: o.fingerprint,
        })}`,
      ),
  };
}
