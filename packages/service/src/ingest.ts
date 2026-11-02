import {
  type Db,
  type EventInput,
  type Logger,
  createCapture,
  reportingEvents,
} from '@wtfalch/reporting-core';
import { ServiceError } from './errors.js';
import { namesOnly } from './log.js';
import { type ErrorReport, OCCURRED_AT_WINDOW_MS, type SiteKeyConfig } from './schema.js';

/** The environment variable that holds the operator key: its value is redacted
 * from every stored message and stack, beside the estate's own KEYSTORE_*. */
export const OPERATOR_KEY_ENV = 'REPORTING_OPERATOR_KEY';

export interface IngestOptions {
  readonly db: Db;
  readonly log: Logger;
  readonly now: () => Date;
  /** Extra environment variable names whose values are redacted on ingest
   * (core's `heldSecrets`), beside `REPORTING_OPERATOR_KEY` and KEYSTORE_*. */
  readonly redactEnvVars?: readonly string[];
}

/** Where a report's own time is trusted: within a week before arrival and five
 * minutes after it. Outside that, the arrival time. */
export function occurredAtOf(value: string | undefined, arrived: Date): Date {
  if (value === undefined) return arrived;
  const at = new Date(value);
  const ms = at.getTime();
  if (Number.isNaN(ms)) return arrived;
  const now = arrived.getTime();
  if (ms < now - OCCURRED_AT_WINDOW_MS.past || ms > now + OCCURRED_AT_WINDOW_MS.future) {
    return arrived;
  }
  return at;
}

/** The text the presenting key's own secret would be replaced with, should a
 * sender quote it in a message or a stack. Core redacts the operator key
 * through `heldSecrets`; a site key is not in the environment. */
const REDACTED_SITE_KEY = '[redacted: site key]';

/** A thrown value carrying the report's text, so core's capture sees exactly
 * what it sees in an app: an `Error` with that message and that stack, or no
 * stack at all. The class name travels as `kind`, the capture's override. */
function errorOf(report: ErrorReport, secret: string): Error {
  const hide = (text: string) => (secret ? text.split(secret).join(REDACTED_SITE_KEY) : text);
  const error = new Error(hide(report.message));
  Object.defineProperty(error, 'stack', {
    value: report.stack === undefined ? undefined : hide(report.stack),
    writable: true,
    configurable: true,
  });
  return error;
}

/**
 * Writes one batch through core's capture: per report, the same redaction
 * (`redactPii`, `heldSecrets` with the operator key added), the same
 * fingerprint and the same group upsert an app runs when it captures in
 * process, so a group keeps its fingerprint when the app moves to sending.
 * Site, environment and tenant come from the key; time from the report,
 * within `OCCURRED_AT_WINDOW_MS`; color and release from the report only,
 * never this host's own.
 *
 * All or nothing: the batch runs in one transaction (core's per-group upsert
 * becomes a savepoint in it), and the timeline rows are one insert at the end.
 * Core's capture never throws, so a failure is seen as an error-level line
 * from it and turns into `unavailable` after the transaction rolls back.
 */
export async function ingestErrors(
  o: IngestOptions,
  key: SiteKeyConfig,
  reports: readonly ErrorReport[],
  secret = '',
): Promise<number> {
  const arrived = o.now();
  let failed = false;
  const log = namesOnly(o.log, () => {
    failed = true;
  });
  const redactEnvVars = [OPERATOR_KEY_ENV, ...(o.redactEnvVars ?? [])];
  try {
    await o.db.transaction(async (tx) => {
      const rows: (typeof reportingEvents.$inferInsert)[] = [];
      for (const report of reports) {
        const at = occurredAtOf(report.occurredAt, arrived);
        const pending: (() => Promise<void>)[] = [];
        const capture = createCapture({
          db: tx,
          log,
          site: key.site,
          environment: key.environment,
          now: () => at,
          defer: (fn) => {
            pending.push(fn);
          },
          event: (input: EventInput) => {
            rows.push({
              occurredAt: at,
              level: input.level ?? 'error',
              kind: input.kind,
              site: key.site,
              environment: key.environment,
              release: report.release ?? null,
              color: report.color ?? null,
              tenantId: input.tenantId ?? null,
              requestId: input.requestId ?? null,
              message: input.message,
              data: (input.data ?? {}) as Record<string, string | number | boolean | null>,
            });
          },
          release: null,
          redactEnvVars,
        });
        capture(errorOf(report, secret), {
          runtime: report.runtime,
          kind: report.kind,
          release: report.release ?? null,
          color: report.color ?? null,
          requestId: report.requestId ?? null,
          tenantId: key.tenantId,
        });
        // One at a time: the upserts share the transaction's one connection.
        for (const fn of pending) await fn();
        if (failed) throw new ServiceError('unavailable', 'Service unavailable');
      }
      if (rows.length !== reports.length) {
        throw new ServiceError('unavailable', 'Service unavailable');
      }
      await tx.insert(reportingEvents).values(rows);
    });
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    o.log.error(
      { err: error instanceof Error ? error.name : 'unknown' },
      'reporting: ingest failed',
    );
    throw new ServiceError('unavailable', 'Service unavailable');
  }
  return reports.length;
}
