import type { Reporting } from '@wtfalch/reporting-core';
import { ServiceError, errorResponse, handle, json, readJson, requirePermission } from './http.js';
import type { ReportingPrincipal } from './principal.js';

export interface CreateRequestsHandlerOptions {
  /** Only the counter (requests.ts) is used; it never throws and is flushed on its own timer. */
  readonly reporting: Pick<Reporting, 'requests'>;
  readonly principal: ReportingPrincipal | null;
}

function record(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

/**
 * `POST /` counts one response for the release reads (requests.ts): a
 * caller reports a status and, optionally, how long the request took.
 * `status` alone is a plain `record()`; `error: true` with no `status` is
 * `recordError()`, for a 5xx noticed after the response already went out
 * -- the table's own check constraint means this only ever makes sense
 * for a minute bucket that already has a `record()` call in it (never
 * one of its own), same as `requests.ts`'s own doc comment says. Like
 * events and error ingest, this never fails the caller over a storage
 * problem -- `RequestCounter` only ever batches in memory and flushes on
 * its own timer, so there is nothing here that can throw past the shape
 * check.
 */
export function createRequestsHandler(options: CreateRequestsHandlerOptions) {
  return (request: Request): Promise<Response> =>
    handle(async () => {
      if (request.method !== 'POST') return errorResponse('not_found', 'Route not found');
      requirePermission(options.principal, 'reporting:ingest');
      const body = await readJson(request);
      const status = record(body, 'status');
      const durationMs = record(body, 'durationMs');
      const isError = record(body, 'error');
      if (status === undefined && isError !== true) {
        throw new ServiceError('invalid_request', 'status is required unless error is true');
      }
      if (isError === true && status === undefined) {
        options.reporting.requests.recordError();
        return json({ accepted: true }, 202);
      }
      if (typeof status !== 'number' || !Number.isInteger(status)) {
        throw new ServiceError('invalid_request', 'status must be an integer');
      }
      options.reporting.requests.record(
        status,
        typeof durationMs === 'number' ? durationMs : undefined,
      );
      return json({ accepted: true }, 202);
    });
}
