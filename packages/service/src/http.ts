import type { Permission, ReportingPrincipal } from './principal.js';
import { principalAllows } from './principal.js';

/** Builds an instance of a `readonly`-fielded wire type field by field. */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export type ServiceErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'unavailable';

/** The one error class every handler throws; `handle()` is the only place that catches it. */
export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

function statusFor(code: ServiceErrorCode): number {
  switch (code) {
    case 'invalid_request':
      return 400;
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    default:
      return 503;
  }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}

/** The wire shape `packages/sdk/src/transport.ts`'s `errorFrom` reads. */
export function errorResponse(code: ServiceErrorCode, message: string): Response {
  return json({ error: { code, message } }, statusFor(code));
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ServiceError('invalid_request', 'Invalid JSON body');
  }
}

/** Throws `unauthorized` for no credential, `forbidden` for a credential missing this permission. */
export function requirePermission(
  principal: ReportingPrincipal | null,
  permission: Permission,
): ReportingPrincipal {
  if (!principal) throw new ServiceError('unauthorized', 'A valid credential is required');
  if (!principalAllows(principal, permission)) throw new ServiceError('forbidden', 'Access denied');
  return principal;
}

/**
 * Every handler's outer shell: run the route, turn a thrown `ServiceError`
 * into its wire response, and anything else (a query that threw) into
 * `unavailable` rather than leak its message. Never used for a write route's
 * own storage failure -- `event()`/`captureError()` never throw for that, by
 * design (writer.ts, errors/capture.ts), so this only ever sees a refusal or
 * a genuinely broken read.
 */
export async function handle(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ServiceError) return errorResponse(error.code, error.message);
    return errorResponse('unavailable', 'Service unavailable');
  }
}
