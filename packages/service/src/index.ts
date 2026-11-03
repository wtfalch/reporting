import type { Logger, Reporting, ReportingOptions } from '@wtfalch/reporting-core';
import { createReporting } from '@wtfalch/reporting-core';
import {
  type Housekeeping,
  createHousekeeping,
  pruneErrors,
  pruneEvents,
  pruneOpenErrors,
  retentionLag,
} from '@wtfalch/reporting-core/housekeeping';
import { createErrorsHandler } from './errors.js';
import { createEventsHandler } from './events.js';
import type { ReportingPrincipal } from './principal.js';
import { createReleaseHealthHandler } from './release-health.js';
import { createRequestsHandler } from './requests.js';
import { createSettingsHandler } from './settings.js';

export * from './principal.js';
export { createEventsHandler } from './events.js';
export { createErrorsHandler } from './errors.js';
export { createRequestsHandler } from './requests.js';
export { createSettingsHandler } from './settings.js';
export { createReleaseHealthHandler } from './release-health.js';
export { ServiceError, type ServiceErrorCode } from './http.js';

export type CreateReportingServiceOptions = ReportingOptions;

type RequestHandler = (request: Request) => Promise<Response>;

export interface ReportingService {
  /** The core instance underneath every route, for a host that wants direct access (e.g. its own health check). */
  readonly reporting: Reporting;
  /** Registered with `pruneEvents`, `retentionLag`, `pruneOpenErrors` and `pruneErrors`. The host calls `.tick()` on its own cadence -- nothing here starts a timer of its own (housekeeping/index.ts). */
  readonly housekeeping: Housekeeping;
  readonly events: (principal: ReportingPrincipal | null) => RequestHandler;
  readonly errors: (principal: ReportingPrincipal | null) => RequestHandler;
  readonly requests: (principal: ReportingPrincipal | null) => RequestHandler;
  readonly settings: (principal: ReportingPrincipal | null) => RequestHandler;
  readonly releaseHealth: (principal: ReportingPrincipal | null) => RequestHandler;
}

const noopLog: Logger = { info() {}, warn() {}, error() {} };

/**
 * One call per host process: builds the one `Reporting` instance every
 * route and the housekeeping tick share (so the writer's and request
 * counter's in-memory batching does what it is for -- see writer.ts,
 * requests.ts), and the five route factories the issue's modules map to:
 * `events` (writer.ts + reader.ts), `errors` (errors/capture.ts, through
 * redact.ts, + errors/reader.ts), `requests` (requests.ts), `settings`
 * (settings.ts) and `releaseHealth` (the handler-factory counterpart of
 * `next/release-health.ts`).
 *
 * `alerts.ts` gets no route of its own: an `alert.<check>` row is already
 * reachable through the `events` route (filter `kindNs=alert`), and firing
 * one is internal to the write paths above (index.ts's `fireAlert`) rather
 * than something a remote caller does directly. A host that wants its own
 * paging channel passes `onAlert` here, same as `createReporting` always
 * has.
 *
 * Each returned handler takes the caller's already-resolved principal (or
 * `null` for no valid credential) and gives back a plain
 * `(request: Request) => Promise<Response>` -- a handler factory, not a
 * server. Nothing here reads a token; the data service host verifies it,
 * builds the principal, and calls e.g. `service.events(principal)` to get
 * the function it mounts under `/events/`.
 */
export function createReportingService(options: CreateReportingServiceOptions): ReportingService {
  const log = options.log ?? noopLog;
  const reporting = createReporting({ ...options, log });
  const housekeeping = createHousekeeping({ reporting, db: options.db, now: options.now });
  housekeeping.register(pruneEvents);
  housekeeping.register(retentionLag);
  housekeeping.register(pruneOpenErrors);
  housekeeping.register(pruneErrors);

  return {
    reporting,
    housekeeping,
    events: (principal) => createEventsHandler({ reporting, principal }),
    errors: (principal) => createErrorsHandler({ db: options.db, reporting, principal }),
    requests: (principal) => createRequestsHandler({ reporting, principal }),
    settings: (principal) => createSettingsHandler({ reporting, principal }),
    releaseHealth: (principal) =>
      createReleaseHealthHandler({ db: options.db, site: reporting.site, log, principal }),
  };
}
