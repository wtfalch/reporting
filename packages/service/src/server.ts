import type { AccessResource, ResourceAccess } from '@wtfalch/authz';
import { type ServiceErrorCode, serviceErrorResponse } from '@wtfalch/contracts';
import type {
  CreateReportingRequest,
  ListReportingsResponse,
  Reporting,
} from '@wtfalch/reporting-sdk';
import type { Permission } from './catalogue.js';
import type { Queryable } from './db.js';
import { ServiceError } from './errors.js';
import { createReporting, listReportings } from './store.js';

/** The caller's authorization binding for this request, resolved by the
 * host from its own auth stack. Never built from request data. */
export interface ReportingCallerContext {
  readonly applicationId: string;
  readonly platformId: string;
  readonly access: ResourceAccess;
}

export interface AuditEvent {
  readonly operation: Permission;
  readonly organisationId: string;
  readonly resourceId: string;
}

export interface CreateReportingHandlerOptions {
  /** The reportings table connection; `store.ts`'s functions run against it. */
  store: Queryable;
  /** Resolves the caller's authorization binding for this request. `null`
   * for an unauthenticated/unrecognised caller -- the handler answers 401
   * without touching the store. */
  resolveAccess: (request: Request) => Promise<ReportingCallerContext | null>;
  /** Called once, after a successful write. */
  audit: (event: AuditEvent) => Promise<void>;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}
function errorResponse(code: ServiceErrorCode, message: string): Response {
  return serviceErrorResponse(new ServiceError(code, message));
}
function resource(context: ReportingCallerContext, organisationId: string): AccessResource {
  return {
    id: 'reportings',
    type: 'reportings.reporting',
    applicationId: context.applicationId,
    platformId: context.platformId,
    organisationId,
    teamId: null,
  };
}
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ServiceError('invalid_request', 'Invalid JSON body');
  }
}
function requireOrganisationId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new ServiceError('invalid_request', 'organisationId is required');
  return value;
}

/** Routes `POST /v1/reportings` (create) and `GET /v1/reportings` (list, filtered
 * by the `organisationId` query parameter). Every route asks
 * `context.access` whether the caller may act, on the target organisation,
 * before the store is ever touched -- an unauthorised caller never causes a
 * query. `resolveAccess` and `audit` are injected: this module never builds
 * its own authentication or audit trail, so the host stays the composition
 * root. */
export function createReportingHandler(options: CreateReportingHandlerOptions) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== '/v1/reportings') return errorResponse('not_found', 'Route not found');
    const context = await options.resolveAccess(request);
    if (!context) return errorResponse('unauthorized', 'A valid credential is required');
    try {
      if (request.method === 'POST') {
        const body = (await readJson(request)) as Partial<CreateReportingRequest>;
        const organisationId = requireOrganisationId(body.organisationId);
        if (typeof body.name !== 'string' || body.name.trim() === '')
          throw new ServiceError('invalid_request', 'name is required');
        if (!context.access.allows('reportings:create', resource(context, organisationId)))
          throw new ServiceError('forbidden', 'Access denied');
        const reporting = await createReporting(options.store, { organisationId, name: body.name });
        await options.audit({
          operation: 'reportings:create',
          organisationId,
          resourceId: reporting.id,
        });
        return json(reporting satisfies Reporting, 201);
      }
      if (request.method === 'GET') {
        const organisationId = requireOrganisationId(url.searchParams.get('organisationId'));
        if (!context.access.allows('reportings:read', resource(context, organisationId)))
          throw new ServiceError('forbidden', 'Access denied');
        const reportings = await listReportings(options.store, organisationId);
        return json({ reportings } satisfies ListReportingsResponse);
      }
      return errorResponse('not_found', 'Route not found');
    } catch (error) {
      if (error instanceof ServiceError) return errorResponse(error.code, error.message);
      return errorResponse('unavailable', 'Service unavailable');
    }
  };
}
