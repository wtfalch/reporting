import type { ReportingError, ReportingErrorCode } from './types.js';

const KNOWN_CODES: readonly ReportingErrorCode[] = [
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'not_configured',
  'rate_limited',
  'unavailable',
];

/** How long one request may take before it is abandoned, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 5000;

/** A typed failure, never a bare `Error`. `status` is the HTTP status (0 when
 * no answer came: a lost connection or the timeout); `code` and `message` are
 * the backend's own wire error (see `ReportingError`). */
export class ReportingApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ReportingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReportingApiError';
  }
}

/** Reads `{ error: { code, message } }`. An unknown or missing code is `unavailable`. */
export function errorFrom(value: unknown): ReportingError {
  const error =
    typeof value === 'object' && value !== null && 'error' in value
      ? (value as { error: unknown }).error
      : null;
  const rawCode =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  const rawMessage =
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
      ? error.message
      : undefined;
  const code = (KNOWN_CODES as readonly string[]).includes(rawCode ?? '')
    ? (rawCode as ReportingErrorCode)
    : 'unavailable';
  return { code, message: rawMessage ?? 'Request failed' } as ReportingError;
}

export interface TransportOptions {
  /** The backend's origin, `https://reporting.<domain>`. */
  url: string;
  /** The bearer credential sent on every request. */
  credential: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Fetch-based: JSON in, JSON out, a bearer on every request, bounded by a
 * timeout. No Node-only imports, so it runs in a Cloudflare Worker and a
 * browser as well as Node.
 */
export function createTransport(options: TransportOptions) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async <T>(method: string, path: string, input?: unknown): Promise<T> => {
    const fetcher = options.fetch ?? (typeof fetch === 'undefined' ? undefined : fetch);
    if (!fetcher) throw new ReportingApiError(0, 'unavailable', 'No fetch available');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // The timer is cleared only once the whole request -- headers and body --
    // has settled, so a response that stalls after its headers still times
    // out: a response's body is also governed by the signal that aborted it.
    try {
      let response: Response;
      try {
        response = await fetcher(new URL(path, options.url), {
          method,
          headers: {
            authorization: `Bearer ${options.credential}`,
            ...(input === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: input === undefined ? undefined : JSON.stringify(input),
          signal: controller.signal,
        });
      } catch (error) {
        const timedOut = controller.signal.aborted;
        throw new ReportingApiError(
          0,
          'unavailable',
          timedOut ? 'The request timed out' : `The request failed: ${errorName(error)}`,
        );
      }
      let value: unknown;
      try {
        value =
          response.status === 204 ? undefined : await raceAbort(response.json(), controller.signal);
      } catch {
        if (controller.signal.aborted) {
          throw new ReportingApiError(0, 'unavailable', 'The request timed out');
        }
        throw new ReportingApiError(response.status, 'unavailable', 'Invalid response body');
      }
      if (!response.ok) {
        const { code, message } = errorFrom(value);
        throw new ReportingApiError(response.status, code, message);
      }
      return value as T;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/** Rejects as soon as `signal` aborts, even when the given promise (a body
 * read already underway) never settles on its own -- a custom `fetch` is not
 * guaranteed to tie its `Response`'s body stream to the signal it was given,
 * so the timeout cannot rely on that happening by itself. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // We're already rejecting below; `promise`'s own outcome no longer
    // matters, but it still must be observed -- otherwise, when it settles
    // on its own (most likely a rejection, for a request that is being
    // abandoned), it becomes an unhandled rejection.
    promise.catch(() => undefined);
    return Promise.reject(new Error('aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
