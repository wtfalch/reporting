/**
 * The wire contract of a company's reporting backend (docs/plans/backend.md,
 * "The contract"). These types are the SDK's own copy: it imports nothing
 * from the service, so an app and Boule pull in no server code.
 */

export type ErrorRuntime = 'server' | 'edge' | 'browser';
export type ErrorState = 'open' | 'resolved' | 'ignored';
export type ReportingEnvironment = 'production' | 'stage';
export type DeployColor = 'blue' | 'green';

/** Who did something, as core's `Actor`: Boule sends `{ class: 'human', id }`. */
export interface Actor {
  class: 'human' | 'api_key' | 'agent' | 'service';
  id: string;
}

export interface ErrorContext {
  company?: string;
  mcp?: string;
  account?: string;
}

export type ContextKey = keyof ErrorContext;

/**
 * What a sender sends. Never a site, environment or tenant: those come from
 * the site key. Where in the app the error happened belongs in the message or
 * the stack; the backend has no column for it.
 */
export interface ErrorReport {
  /** The class name, `TypeError`. Absent, the backend groups it as `Error`. */
  kind?: string;
  message: string;
  stack?: string;
  runtime: ErrorRuntime;
  release?: string;
  color?: DeployColor;
  requestId?: string;
  /** The `requestId` of the report this one retries: the link from a retry back to the first try. */
  retryOf?: string;
  /** Opaque ids the screens filter and count by. Org-chosen ids, 1-128 characters of `A-Za-z0-9_.:-`; never an email or a name. Stored raw. */
  context?: ErrorContext;
  /** The signed-in person's issuer id or a session id (1-256 characters); the backend stores only a hash. Never an email or a name. */
  person?: string;
  /** ISO time. The sender stamps the time of `send` when absent. */
  occurredAt?: string;
}

/** One error group, as a reader gets it. */
export interface ErrorGroup {
  /** 32 lower-case hex characters, scoped to the group's site and environment:
   * the same error in another app, or in this app's other environment, is
   * another group with another fingerprint. */
  fingerprint: string;
  site: string;
  environment: string;
  kind: string;
  message: string;
  stack: string | null;
  runtime: ErrorRuntime;
  release: string | null;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  requestId: string | null;
  state: ErrorState;
  resolvedAt: string | null;
  resolvedBy: Actor | null;
  /** How many different people hit it, from the reports that named a `person`
   * and are still within event retention; `null` when none of them named one. */
  people: number | null;
  /** Distinct context ids on the group's events in retention, sorted, at most 20 per key. */
  contexts: { company: string[]; mcp: string[]; account: string[] };
  /** How many of the group's events in retention are retries (carry `retryOf`). */
  retries: number;
}

/** `GET /v1/errors`: newest `lastSeenAt` first. `next` is an opaque cursor, or null on the last page. */
export interface ErrorsPage {
  items: ErrorGroup[];
  next: string | null;
}

export interface ListErrorsOptions {
  site: string;
  environment?: ReportingEnvironment;
  /** Defaults to `open` on the backend. */
  state?: ErrorState;
  runtime?: ErrorRuntime;
  search?: string;
  /** 1 to 100; the backend's default is 50. */
  limit?: number;
  /** The `next` of the previous page. */
  after?: string;
  /** Keep groups with an event carrying this id. */
  company?: string;
  mcp?: string;
  account?: string;
}

export interface GetErrorOptions {
  site: string;
  fingerprint: string;
  company?: string;
  mcp?: string;
  account?: string;
}

export interface SetErrorStateInput {
  site: string;
  fingerprint: string;
  state: ErrorState;
  by: Actor;
}

export interface ErrorSeriesOptions {
  site: string;
  environment?: ReportingEnvironment;
  from: Date | string;
  to: Date | string;
  /** Minutes per bucket: 60 (the default) or 1440. */
  bucket?: 60 | 1440;
  fingerprint?: string;
  company?: string;
  mcp?: string;
  account?: string;
}

export interface ByContextOptions {
  site: string;
  environment?: ReportingEnvironment;
  /** At most 31 days from `from`. */
  from: Date | string;
  to: Date | string;
  by: ContextKey;
}

/** `GET /v1/errors/by-context`: at most 100 ids, most errors first. */
export interface ByContext {
  items: { id: string; errors: number; groups: number }[];
}

export interface ErrorSeries {
  bucketMinutes: number;
  /** Every bucket from `from`, zeros included. */
  buckets: { start: string; errors: number }[];
}

/** `POST /v1/errors` answers `202 { accepted }`. */
export interface IngestResponse {
  accepted: number;
}

/** The wire shape of a failed request's `error`, discriminated on `code` so a
 * caller can narrow on it. Every non-2xx body is `{ error: ReportingError }`
 * (`@wtfalch/contracts`' `serviceErrorResponse`). */
export type ReportingError =
  | { code: 'invalid_request'; message: string }
  | { code: 'unauthorized'; message: string }
  | { code: 'forbidden'; message: string }
  | { code: 'not_found'; message: string }
  | { code: 'not_configured'; message: string }
  | { code: 'rate_limited'; message: string }
  | { code: 'unavailable'; message: string };

export type ReportingErrorCode = ReportingError['code'];
