import type { ReportingError, ReportingErrorCode } from './types.js';

export interface ClientOptions {
  baseUrl: string;
  credential: () => string | Promise<string>;
  fetch?: typeof fetch;
}

const KNOWN_CODES: readonly ReportingErrorCode[] = [
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'unavailable',
];

/** A typed failure, never a bare `Error`. `status` is the HTTP status; `code`
 * and `message` are the service's own wire error (see `ReportingError`). */
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

function errorFrom(value: unknown): ReportingError {
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
  return { code, message: rawMessage ?? 'Request failed' };
}

/** Minimal fetch-based transport: JSON in, JSON out, a bearer credential on
 * every request. No Node-only imports -- this runs in a browser too. */
export function createTransport(options: ClientOptions) {
  return async <T>(method: string, path: string, input?: unknown): Promise<T> => {
    const response = await (options.fetch ?? fetch)(new URL(path, options.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${await options.credential()}`,
        ...(input === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
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
