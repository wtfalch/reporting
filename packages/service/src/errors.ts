import { ServiceError, type ServiceErrorCode, serviceErrorResponse } from '@wtfalch/contracts';

/**
 * Every failure is `@wtfalch/contracts`' `serviceErrorResponse`:
 * `{ error: { code, message } }` with its status per code and
 * `cache-control: no-store`, as analytics answers (docs/plans/backend.md,
 * "The contract"). The codes this service throws are the contract's:
 * `invalid_request`, `unauthorized`, `forbidden`, `not_found`,
 * `not_configured` and `unavailable`. A message is fixed text written here,
 * never a value from the request.
 */
export { ServiceError, type ServiceErrorCode };

export function errorResponse(code: ServiceErrorCode, message: string): Response {
  return serviceErrorResponse(new ServiceError(code, message));
}

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
