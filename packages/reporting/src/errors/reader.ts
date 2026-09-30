import { and, desc, eq, ilike, lt, or, sql } from 'drizzle-orm';
import type { ErrorState } from '../schema.js';
import type { ReportingErrorRow, TenantErrorRow } from '../tables.js';
import { reportingErrorTenants, reportingErrors } from '../tables.js';
import type { Actor, Db, ErrorsPage, ErrorsPageOptions } from '../types.js';

/** Postgres's default LIKE/ILIKE escape is backslash; escaping the pattern's own three special characters is what makes a search term match itself literally rather than as a wildcard pattern. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The columns a tenant may see of a shared group. The text and request facts
 * of the group belong to whichever tenant hit it last, so they are null.
 */
function tenantColumns() {
  return {
    fingerprint: reportingErrors.fingerprint,
    site: reportingErrors.site,
    environment: reportingErrors.environment,
    kind: reportingErrors.kind,
    message: sql<null>`null`.as('message'),
    stack: sql<null>`null`.as('stack'),
    runtime: sql<null>`null`.as('runtime'),
    release: sql<null>`null`.as('release'),
    requestId: sql<null>`null`.as('request_id'),
    resolvedBy: sql<null>`null`.as('resolved_by'),
    state: reportingErrors.state,
    resolvedAt: reportingErrors.resolvedAt,
    tenantId: reportingErrorTenants.tenantId,
    occurrences: reportingErrorTenants.occurrences,
    firstSeenAt: reportingErrorTenants.firstSeenAt,
    lastSeenAt: reportingErrorTenants.lastSeenAt,
  };
}

/**
 * Newest first, keyset-paged on `(last_seen_at, fingerprint)`, the table's
 * index. Every filter is an equality on an indexed column, except `search`:
 * a case-insensitive substring match on `message` or `stack`, for triaging
 * an incident by grepping the group list rather than raw rows by hand (gap
 * issue #8). Unindexed by design -- a trigram index would need the
 * pg_trgm extension, an operational cost this triage tool does not carry
 * for its scale. No permission is applied here: the host gates, and this
 * returns rows as stored.
 */
export async function errorsPage(db: Db, opts: ErrorsPageOptions = {}): Promise<ErrorsPage> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  // With a tenant, the page is that tenant's own view: its rows join the
  // group and supply the counts and times, so ordering and paging follow the
  // tenant's last occurrence, not anyone else's.
  const seen = opts.tenantId ? reportingErrorTenants.lastSeenAt : reportingErrors.lastSeenAt;
  const conditions = [];
  if (opts.site) conditions.push(eq(reportingErrors.site, opts.site));
  if (opts.state) conditions.push(eq(reportingErrors.state, opts.state));
  // `runtime` and the text are the latest sample from any tenant, so a tenant
  // scope neither filters on the first nor searches the rest: either would be
  // an oracle on another tenant's data. Search matches `kind` there.
  if (opts.runtime && !opts.tenantId) conditions.push(eq(reportingErrors.runtime, opts.runtime));
  const search = opts.search?.trim().slice(0, 200);
  if (search) {
    const pattern = likePattern(search);
    const clause = opts.tenantId
      ? ilike(reportingErrors.kind, pattern)
      : or(ilike(reportingErrors.message, pattern), ilike(reportingErrors.stack, pattern));
    if (clause) conditions.push(clause);
  }
  if (opts.environment) conditions.push(eq(reportingErrors.environment, opts.environment));
  if (opts.after) {
    const { lastSeenAt, fingerprint } = opts.after;
    const keyset = or(
      lt(seen, lastSeenAt),
      and(eq(seen, lastSeenAt), lt(reportingErrors.fingerprint, fingerprint)),
    );
    if (keyset) conditions.push(keyset);
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const order = [desc(seen), desc(reportingErrors.fingerprint)] as const;
  const rows = opts.tenantId
    ? await db
        .select(tenantColumns())
        .from(reportingErrors)
        .innerJoin(
          reportingErrorTenants,
          and(
            eq(reportingErrorTenants.fingerprint, reportingErrors.fingerprint),
            eq(reportingErrorTenants.tenantId, opts.tenantId),
          ),
        )
        .where(where)
        .orderBy(...order)
        .limit(limit + 1)
    : await db
        .select()
        .from(reportingErrors)
        .where(where)
        .orderBy(...order)
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

/**
 * One row by fingerprint, or null when it is unknown. With `tenantId`, null
 * too when that tenant never hit it, and the row is a `TenantErrorRow`: the
 * counts and times are the tenant's own and the shared text is null, as in
 * `errorsPage`.
 */
export async function errorDetail(
  db: Db,
  fingerprint: string,
  opts: { readonly tenantId?: string } = {},
): Promise<ReportingErrorRow | TenantErrorRow | null> {
  if (opts.tenantId) {
    const scoped = await db
      .select(tenantColumns())
      .from(reportingErrors)
      .innerJoin(
        reportingErrorTenants,
        and(
          eq(reportingErrorTenants.fingerprint, reportingErrors.fingerprint),
          eq(reportingErrorTenants.tenantId, opts.tenantId),
        ),
      )
      .where(eq(reportingErrors.fingerprint, fingerprint))
      .limit(1);
    return scoped[0] ?? null;
  }
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
