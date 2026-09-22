import { sql } from 'drizzle-orm';
import { ERROR_RUNTIMES, KIND_PATTERN, LIMITS } from '../schema.js';
import type { ErrorRuntime } from '../schema.js';
import { reportingErrors } from '../tables.js';
import type { CaptureContext, Db, EventInput, Logger } from '../types.js';
import { describe } from '../writer.js';
import { errorKind, fingerprint } from './fingerprint.js';
import { heldSecrets, redactText } from './redact.js';

/**
 * The one path an uncaught exception takes into the estate
 * (docs/plans/errors.md, "Surface" and "Why a second table, not just an
 * event row"): one `reporting_events` row for the timeline, through the
 * writer's own `event()` so it shares its queue, batching and logger line,
 * and one upsert into the fingerprint's group — first seen, last seen, how
 * many, and whether an operator has already dealt with it.
 *
 * Two contracts this must never break, both sharpened from the writer's own
 * (writer.ts's header comment) for an error reporter specifically:
 *
 * 1. A capture must never carry a secret. Redaction runs on `message` and
 *    `stack` before anything else touches them — a stack is the likeliest
 *    way a wrapping key leaves the process (redact.ts) — and the
 *    fingerprint is computed on that same redacted text, so a secret can
 *    never reach the digest basis either.
 * 2. A capture must never throw back into the code that threw the original
 *    error. The whole body of `captureError` is one try/catch, and the
 *    group upsert — the one part of this that touches a database that can
 *    be down — is scheduled through the host's `defer` and wrapped in its
 *    own catch, exactly as the writer's flush protects the request from a
 *    failed insert. An error reporter that itself throws while reporting an
 *    error is the one failure mode worse than not reporting it.
 */

export interface CaptureOptions {
  readonly db: Db;
  readonly log: Logger;
  readonly site: string;
  /** Stamped on every group the same way `release` is; see `ReportingOptions.environment`. */
  readonly environment?: string | null;
  readonly now: () => Date;
  /** Runs the group upsert after the current unit of work, same as the writer's flush (writer.ts). */
  readonly defer: (fn: () => Promise<void>) => void;
  /** The Writer's own `event()`, so the timeline row shares its queue, batching and logger line. */
  readonly event: (input: EventInput) => void;
  /** Stamped on a fresh group when a capture's own context supplies none. */
  readonly release?: string | null;
  /** Extra env var names `heldSecrets` also redacts, beyond the estate's own KEYSTORE_*; see `ReportingOptions.redactEnvVars`. */
  readonly redactEnvVars?: readonly string[];
}

const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g;
const INVALID_KIND_CHARS = /[^a-z0-9_]+/g;

/** camelCase/PascalCase/anything, folded down to what `KIND_PATTERN` allows. */
function snakeCase(name: string): string {
  const lowered = name.replace(CAMEL_BOUNDARY, '$1_$2').toLowerCase();
  return lowered
    .replace(INVALID_KIND_CHARS, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * `error.<snake_case class name>` for the timeline row's `kind`. Falls back
 * to `error.unknown` rather than refuse the capture: a class name that
 * cannot become a valid `namespace.name` once lower-cased (it leads with a
 * digit, or is nothing but punctuation) is itself informative, but not worth
 * losing the whole report over.
 */
function eventKindFor(kind: string): string {
  const candidate = `error.${snakeCase(kind)}`;
  return KIND_PATTERN.test(candidate) ? candidate : 'error.unknown';
}

/** `errorKind(error)`, unless the caller already knows the class better than the thrown value can say (a JSON-serialised browser report, say). */
function resolveKind(error: unknown, override: string | undefined): string {
  const trimmed = override?.trim();
  return trimmed && trimmed.length > 0 ? trimmed.slice(0, 100) : errorKind(error);
}

/** Safe for every throw JavaScript actually allows: a string, `null`, an object with no message at all. Never empty, so it always clears the table's and the schema's non-empty checks. */
function messageOf(error: unknown, kind: string): string {
  if (error instanceof Error) return error.message || error.name || kind;
  if (typeof error === 'string') return error || kind;
  if (error === null) return 'null';
  if (error === undefined) return 'undefined';
  try {
    return String(error) || kind;
  } catch {
    return kind;
  }
}

/** Only a real `Error` has a stack worth keeping; everything else groups on `kind` and the message alone (fingerprint.ts). */
function stackOf(error: unknown): string | null {
  return error instanceof Error && typeof error.stack === 'string' ? error.stack : null;
}

/** Keeps the top of the text — the start, where the throw site and its callers are — and drops the rest. */
function truncateEnd(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * `reporting_errors.tenant_id` is a uuid column and the event row's schema
 * refuses anything else, so a caller that hands over a slug, an empty string
 * or a number loses the whole group row rather than just the attribution.
 * Callers are not all trusted to the same degree -- `./next`'s client ingest
 * takes what a browser posted -- so the guard lives here, at the one door
 * every capture goes through.
 */
function validTenant(value: string | null | undefined): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normaliseRuntime(runtime: CaptureContext['runtime']): ErrorRuntime {
  return runtime && (ERROR_RUNTIMES as readonly string[]).includes(runtime) ? runtime : 'server';
}

interface GroupSample {
  readonly fingerprint: string;
  readonly kind: string;
  readonly message: string;
  readonly stack: string | null;
  readonly runtime: ErrorRuntime;
  readonly release: string | null;
  readonly environment: string | null;
  readonly tenantId: string | null;
  readonly requestId: string | null;
  readonly at: Date;
}

/**
 * `insert ... on conflict (fingerprint) do update`, one round trip so two
 * occurrences arriving at once still land as one row: bump `occurrences`,
 * move `last_seen_at`, overwrite the sample fields with the newest
 * occurrence. `first_seen_at` is left out of `set` entirely, so a conflict
 * never moves it.
 *
 * A resolved or ignored group reopens: the pair the table's own CHECK
 * enforces (`reporting_errors_resolved_pair_check`, 0003_errors.sql) means
 * `state` can only move back to 'open' by clearing `resolved_at` and
 * `resolved_by` in the same statement, never one alone.
 */
async function upsertGroup(db: Db, site: string, s: GroupSample): Promise<void> {
  const reopened = sql`case when ${reportingErrors.state} in ('resolved', 'ignored') then 'open' else ${reportingErrors.state} end`;
  await db
    .insert(reportingErrors)
    .values({
      fingerprint: s.fingerprint,
      site,
      kind: s.kind,
      message: s.message,
      stack: s.stack,
      runtime: s.runtime,
      release: s.release,
      environment: s.environment,
      firstSeenAt: s.at,
      lastSeenAt: s.at,
      occurrences: 1,
      tenantId: s.tenantId,
      requestId: s.requestId,
    })
    .onConflictDoUpdate({
      target: reportingErrors.fingerprint,
      set: {
        occurrences: sql`${reportingErrors.occurrences} + 1`,
        lastSeenAt: s.at,
        message: s.message,
        stack: s.stack,
        tenantId: s.tenantId,
        requestId: s.requestId,
        release: s.release,
        environment: s.environment,
        state: reopened,
        resolvedAt: sql`case when ${reportingErrors.state} in ('resolved', 'ignored') then null else ${reportingErrors.resolvedAt} end`,
        resolvedBy: sql`case when ${reportingErrors.state} in ('resolved', 'ignored') then null else ${reportingErrors.resolvedBy} end`,
      },
    });
}

/**
 * `captureError(error, context?)`: the class from `errorKind` (or the
 * context's own, when the caller already knows it), the message and stack
 * from the value itself — never assuming it is an `Error` — redacted before
 * anything else touches them, bounded to what the table accepts, then
 * fingerprinted on that same redacted, bounded text so a secret can never
 * reach the digest either.
 *
 * Writes the timeline row synchronously through `o.event()` (the writer
 * queues and logs it), then schedules the group upsert through `o.defer` —
 * no timer of its own, same as the writer's flush. The whole body is one
 * try/catch: nothing here may throw back into the code that threw the
 * original error.
 */
export function createCapture(o: CaptureOptions) {
  return function captureError(error: unknown, context: CaptureContext = {}): void {
    try {
      const kind = resolveKind(error, context.kind);
      const secrets = heldSecrets(process.env, o.redactEnvVars);
      const message = truncateEnd(redactText(messageOf(error, kind), secrets), LIMITS.message);
      const rawStack = stackOf(error);
      const stack =
        rawStack === null ? null : truncateEnd(redactText(rawStack, secrets), LIMITS.stack);
      const fp = fingerprint({ kind, message, stack });
      const runtime = normaliseRuntime(context.runtime);
      // A tenant id that is not a uuid would be refused by the event row's
      // own zod check (schema.ts: `tenantId: z.uuid().nullish()`) and would
      // fail the group upsert at Postgres's cast, which is caught, logged and
      // dropped -- leaving an occurrence with a timeline row and no group.
      // The attribution is worth less than the report, so a malformed id is
      // dropped and the capture goes on.
      const tenantId = validTenant(context.tenantId);
      const requestId = context.requestId ?? null;
      const release = context.release ?? o.release ?? null;
      const environment = o.environment ?? null;
      const at = o.now();

      o.event({
        kind: eventKindFor(kind),
        level: 'error',
        message,
        tenantId,
        requestId,
        data: { fingerprint: fp, runtime },
      });

      const sample: GroupSample = {
        fingerprint: fp,
        kind,
        message,
        stack,
        runtime,
        release,
        environment,
        tenantId,
        requestId,
        at,
      };
      try {
        o.defer(() =>
          upsertGroup(o.db, o.site, sample).catch((err) => {
            o.log.error(
              { err: describe(err), fingerprint: fp },
              'reporting: error group upsert failed',
            );
          }),
        );
      } catch (err) {
        // A host's defer that throws (called outside a request scope, say)
        // must not take the report with it, same as writer.ts's schedule().
        o.log.warn(
          { err: describe(err) },
          'reporting: defer threw; the error group upsert was dropped',
        );
      }
    } catch (err) {
      o.log.error({ err: describe(err) }, 'reporting: captureError failed');
    }
  };
}
