import type {
  CaptureContext,
  Db,
  ErrorRuntime,
  ErrorState,
  ErrorsPage,
  ErrorsPageOptions,
  Reporting,
  ReportingErrorRow,
  TenantErrorRow,
} from '@wtfalch/reporting-core';
import {
  ERROR_STATES,
  FINGERPRINT_PATTERN,
  errorDetail,
  errorsPage,
  setErrorState,
} from '@wtfalch/reporting-core';
import { ServiceError, errorResponse, handle, json, readJson, requirePermission } from './http.js';
import type { Mutable } from './http.js';
import type { ReportingPrincipal } from './principal.js';

export interface CreateErrorsHandlerOptions {
  readonly db: Db;
  /** Only `captureError()` is used -- the capture path (errors/capture.ts), which already redacts (errors/redact.ts) and fingerprints. */
  readonly reporting: Pick<Reporting, 'captureError'>;
  readonly principal: ReportingPrincipal | null;
}

function record(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

/** A fingerprint-shaped last segment addresses one group; anything else (including none) is the collection. */
function fingerprintOf(url: URL): string | null {
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  const last = segments.at(-1);
  return last && FINGERPRINT_PATTERN.test(last) ? last : null;
}

function parseErrorsQuery(url: URL, tenantId: string | undefined): ErrorsPageOptions {
  const params = url.searchParams;
  const opts: Mutable<ErrorsPageOptions> = {};
  const limit = params.get('limit');
  if (limit !== null) {
    const n = Number(limit);
    if (!Number.isFinite(n)) throw new ServiceError('invalid_request', 'limit must be a number');
    opts.limit = n;
  }
  const site = params.get('site');
  if (site !== null) opts.site = site;
  const state = params.get('state');
  if (state !== null) opts.state = state as ErrorState;
  const runtime = params.get('runtime');
  if (runtime !== null) opts.runtime = runtime as ErrorRuntime;
  const search = params.get('search');
  if (search !== null) opts.search = search;
  const environment = params.get('environment');
  if (environment !== null) opts.environment = environment;
  const afterLastSeenAt = params.get('afterLastSeenAt');
  const afterFingerprint = params.get('afterFingerprint');
  if (afterLastSeenAt !== null && afterFingerprint !== null) {
    const lastSeenAt = new Date(afterLastSeenAt);
    if (Number.isNaN(lastSeenAt.getTime())) {
      throw new ServiceError('invalid_request', 'afterLastSeenAt is not a valid date');
    }
    opts.after = { lastSeenAt, fingerprint: afterFingerprint };
  }
  if (tenantId !== undefined) opts.tenantId = tenantId;
  return opts;
}

/**
 * Builds the value `captureError` expects from a posted error report: a
 * real `Error` so `messageOf`/`stackOf` (errors/capture.ts) take their
 * normal path, with `stack` set from what was posted rather than this
 * process's own call site.
 */
function errorFromBody(body: unknown): { error: Error; context: CaptureContext } {
  const message = record(body, 'message');
  if (typeof message !== 'string' || message.length === 0) {
    throw new ServiceError('invalid_request', 'message is required');
  }
  const error = new Error(message);
  const stack = record(body, 'stack');
  if (typeof stack === 'string') error.stack = stack;
  const context: Mutable<CaptureContext> = {};
  const kind = record(body, 'kind');
  if (typeof kind === 'string') context.kind = kind;
  const runtime = record(body, 'runtime');
  if (typeof runtime === 'string') context.runtime = runtime as ErrorRuntime;
  const tenantId = record(body, 'tenantId');
  if (tenantId === null || typeof tenantId === 'string') context.tenantId = tenantId;
  const requestId = record(body, 'requestId');
  if (requestId === null || typeof requestId === 'string') context.requestId = requestId;
  const release = record(body, 'release');
  if (release === null || typeof release === 'string') context.release = release;
  return { error, context };
}

/**
 * `POST /` ingests one captured error (errors/capture.ts, through
 * `redact.ts` before anything else touches `message`/`stack`), always 202
 * once permission and shape pass -- same never-fail-the-caller contract as
 * the events route. `GET /` and `GET /:fingerprint` read the group list and
 * one group (errors/reader.ts); `?tenantId=` scopes both to that tenant's
 * own view. `PATCH /:fingerprint` moves a group's triage state
 * (`setErrorState`) and needs `reporting:resolve`, not `reporting:read`.
 */
export function createErrorsHandler(options: CreateErrorsHandlerOptions) {
  return (request: Request): Promise<Response> =>
    handle(async () => {
      const url = new URL(request.url);
      const fingerprint = fingerprintOf(url);

      if (request.method === 'POST' && fingerprint === null) {
        requirePermission(options.principal, 'reporting:ingest');
        const { error, context } = errorFromBody(await readJson(request));
        options.reporting.captureError(error, context);
        return json({ accepted: true }, 202);
      }

      if (request.method === 'GET') {
        requirePermission(options.principal, 'reporting:read');
        const tenantId = url.searchParams.get('tenantId') ?? undefined;
        if (fingerprint !== null) {
          // `errorDetail`'s tenant scope is keyed on *presence* of `tenantId`,
          // not its truthiness (errors/reader.ts's `tenantScope`): the key
          // must be left off entirely for an unscoped read, never set to
          // `undefined`, or it is read as a malformed tenant id and throws.
          const row =
            tenantId !== undefined
              ? await errorDetail(options.db, fingerprint, { tenantId })
              : await errorDetail(options.db, fingerprint);
          if (!row) return errorResponse('not_found', 'No such error group');
          return json({ error: row } satisfies { error: ReportingErrorRow | TenantErrorRow });
        }
        const page = await errorsPage(options.db, parseErrorsQuery(url, tenantId));
        return json(page satisfies ErrorsPage);
      }

      if (request.method === 'PATCH' && fingerprint !== null) {
        const principal = requirePermission(options.principal, 'reporting:resolve');
        const body = await readJson(request);
        const state = record(body, 'state');
        if (typeof state !== 'string' || !(ERROR_STATES as readonly string[]).includes(state)) {
          throw new ServiceError(
            'invalid_request',
            `state must be one of ${ERROR_STATES.join(', ')}`,
          );
        }
        const row = await setErrorState(
          options.db,
          fingerprint,
          state as ErrorState,
          principal.actor,
        );
        if (!row) return errorResponse('not_found', 'No such error group');
        return json({ error: row } satisfies { error: ReportingErrorRow });
      }

      return errorResponse('not_found', 'Route not found');
    });
}
