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
}

export interface GetErrorOptions {
  site: string;
  fingerprint: string;
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
