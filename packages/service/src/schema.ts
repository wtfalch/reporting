import {
  type Actor,
  ERROR_RUNTIMES,
  ERROR_STATES,
  type ErrorRuntime,
  type ErrorState,
  LIMITS,
  SITE_PATTERN,
  actorSchema,
} from '@wtfalch/reporting-core';
import { z } from 'zod';

export { SITE_PATTERN };

/** The two environments a site key binds (docs/plans/backend.md, "Credentials"). */
export const ENVIRONMENTS = ['production', 'stage'] as const;
export type ReportingEnvironment = (typeof ENVIRONMENTS)[number];

export const COLORS = ['blue', 'green'] as const;

/** What a site key writes as. Never taken from a request body. */
export interface SiteKeyConfig {
  readonly id: string;
  readonly site: string;
  readonly environment: ReportingEnvironment;
  readonly tenantId: string;
}

/** The ingest's bounds: at most 20 reports a batch and 64 KB a body. */
export const INGEST_LIMITS = {
  batch: 20,
  bodyBytes: 64 * 1024,
  kind: 100,
  release: 128,
  requestId: LIMITS.requestId,
  person: 256,
  /** One context id (`company`, `mcp`, `account`): 1-128 characters of `CONTEXT_ID_PATTERN`. */
  contextId: 128,
} as const;

/** Context ids are org-chosen opaque ids, never an email or a name. */
export const CONTEXT_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
export const CONTEXT_KEYS = ['company', 'mcp', 'account'] as const;
export type ContextKey = (typeof CONTEXT_KEYS)[number];

const contextId = z.string().min(1).max(INGEST_LIMITS.contextId).regex(CONTEXT_ID_PATTERN);

/** How far an `occurredAt` may sit from the moment the batch arrives; outside
 * it the arrival time is used. A sender's clock is not trusted to move a
 * group's first or last seen time by more than this. */
export const OCCURRED_AT_WINDOW_MS = {
  past: 7 * 24 * 60 * 60_000,
  future: 5 * 60_000,
} as const;

/**
 * What a sender sends (contract `ErrorReport`). Strict: a report that names
 * its own site, environment or tenant is refused, because those come from
 * the key. `message` and `stack` are not bounded here beyond the body cap:
 * core's capture cuts them after redaction, as it does in an app.
 */
export const errorReportSchema = z.strictObject({
  kind: z.string().trim().min(1).max(INGEST_LIMITS.kind).optional(),
  message: z.string().min(1),
  stack: z.string().optional(),
  runtime: z.enum(ERROR_RUNTIMES),
  release: z.string().min(1).max(INGEST_LIMITS.release).optional(),
  color: z.enum(COLORS).optional(),
  requestId: z.string().min(1).max(INGEST_LIMITS.requestId).optional(),
  /** The report this one retries; same rule as `requestId`. */
  retryOf: z.string().min(1).max(INGEST_LIMITS.requestId).optional(),
  /** Opaque ids the screens filter and count by. Stored raw, beside `person`. */
  context: z
    .strictObject({
      company: contextId.optional(),
      mcp: contextId.optional(),
      account: contextId.optional(),
    })
    .optional(),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  /** Who hit it, as the sender knows them: the signed-in person's issuer id,
   * or a session id. Never stored: the host keeps a one-way hash of it per
   * site and environment (`personHash`), to count people per group. */
  person: z.string().min(1).max(INGEST_LIMITS.person).optional(),
});
export type ErrorReport = z.infer<typeof errorReportSchema>;

export const ingestBodySchema = z.strictObject({
  errors: z.array(errorReportSchema).min(1).max(INGEST_LIMITS.batch),
});

/** `POST /v1/errors/:fingerprint/state`. `by` is core's actor schema, which
 * keeps `class` and `id` and drops anything else a host hands over. */
export const stateBodySchema = z.strictObject({
  site: z.string().regex(SITE_PATTERN),
  state: z.enum(ERROR_STATES),
  by: actorSchema,
});

/** What a reader gets (contract `ErrorGroup`). */
export interface ErrorGroup {
  readonly fingerprint: string;
  readonly site: string;
  readonly environment: string;
  readonly kind: string;
  readonly message: string;
  readonly stack: string | null;
  readonly runtime: ErrorRuntime;
  readonly release: string | null;
  readonly occurrences: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly requestId: string | null;
  readonly state: ErrorState;
  readonly resolvedAt: string | null;
  readonly resolvedBy: Actor | null;
  /** How many different people hit it, from the reports that named one
   * (`ErrorReport.person`) and are still within event retention; `null`
   * when none of them did. */
  readonly people: number | null;
  /** Distinct context ids seen on the group's events in retention, sorted, at most 20 per key. */
  readonly contexts: Readonly<Record<ContextKey, readonly string[]>>;
  /** Events in retention that carry `retryOf`. */
  readonly retries: number;
}

export interface ContextCount {
  readonly id: string;
  readonly errors: number;
  readonly groups: number;
}

export interface ErrorsList {
  readonly items: readonly ErrorGroup[];
  readonly next: string | null;
}

export interface SeriesBucket {
  readonly start: string;
  readonly errors: number;
}

export interface ErrorSeries {
  readonly bucketMinutes: number;
  readonly buckets: readonly SeriesBucket[];
}

export type { Actor, ErrorRuntime, ErrorState };
