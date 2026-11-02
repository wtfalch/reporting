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
    } finally {
      clearTimeout(timer);
    }
    let value: unknown;
    try {
      value = response.status === 204 ? undefined : await response.json();
    } catch {
      throw new ReportingApiError(response.status, 'unavailable', 'Invalid response body');
    }
    if (!response.ok) {
      const { code, message } = errorFrom(value);
      throw new ReportingApiError(response.status, code, message);
    }
    return value as T;
  };
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
