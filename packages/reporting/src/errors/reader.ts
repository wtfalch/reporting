import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { ErrorState } from '../schema.js';
import type { ReportingErrorRow } from '../tables.js';
import { reportingErrors } from '../tables.js';
import type { Actor, Db, ErrorsPage, ErrorsPageOptions } from '../types.js';

/**
 * Newest first, keyset-paged on `(last_seen_at, fingerprint)`, the table's
 * index. Every filter is an equality on an indexed column. No permission is
 * applied here: the host gates, and this returns rows as stored.
 */
export async function errorsPage(db: Db, opts: ErrorsPageOptions = {}): Promise<ErrorsPage> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const conditions = [];
  if (opts.site) conditions.push(eq(reportingErrors.site, opts.site));
  if (opts.state) conditions.push(eq(reportingErrors.state, opts.state));
  if (opts.runtime) conditions.push(eq(reportingErrors.runtime, opts.runtime));
  if (opts.environment) conditions.push(eq(reportingErrors.environment, opts.environment));
  if (opts.after) {
    const { lastSeenAt, fingerprint } = opts.after;
    const keyset = or(
      lt(reportingErrors.lastSeenAt, lastSeenAt),
      and(eq(reportingErrors.lastSeenAt, lastSeenAt), lt(reportingErrors.fingerprint, fingerprint)),
    );
    if (keyset) conditions.push(keyset);
  }
  const rows = await db
    .select()
    .from(reportingErrors)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(reportingErrors.lastSeenAt), desc(reportingErrors.fingerprint))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    next:
      rows.length > limit && last
        ? { lastSeenAt: last.lastSeenAt, fingerprint: last.fingerprint }
        : null,
  };
}

/** One row by fingerprint, or null when it is unknown. */
export async function errorDetail(db: Db, fingerprint: string): Promise<ReportingErrorRow | null> {
  const rows = await db
    .select()
    .from(reportingErrors)
    .where(eq(reportingErrors.fingerprint, fingerprint))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Moves an error's state. 'resolved' and 'ignored' stamp `resolved_at` and
 * `resolved_by` with this instant and who did it; moving back to 'open'
 * clears both, never one alone — `reporting_errors_resolved_pair_check`
 * (0003_errors.sql) refuses a row with only one of the pair set. Returns the
 * updated row, or null when the fingerprint is unknown.
 */
export async function setErrorState(
  db: Db,
  fingerprint: string,
  state: ErrorState,
  by: Actor,
): Promise<ReportingErrorRow | null> {
  const closing = state === 'resolved' || state === 'ignored';
  const rows = await db
    .update(reportingErrors)
    .set({
      state,
      resolvedAt: closing ? sql`now()` : null,
      resolvedBy: closing ? `${by.class}:${by.id}` : null,
    })
    .where(eq(reportingErrors.fingerprint, fingerprint))
    .returning();
  return rows[0] ?? null;
}
