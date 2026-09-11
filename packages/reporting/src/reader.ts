import { and, desc, eq, lt, or } from 'drizzle-orm';
import { reportingEvents } from './tables.js';
import type { Db, EventsPage, EventsPageOptions } from './types.js';

/**
 * Newest first, keyset-paged on `(occurred_at, id)`, which is the table's
 * first index. Every filter is an equality on an indexed column. No
 * permission is applied here: the host gates, and this returns rows as
 * stored.
 */
export async function eventsPage(db: Db, opts: EventsPageOptions = {}): Promise<EventsPage> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const conditions = [];
  if (opts.level) conditions.push(eq(reportingEvents.level, opts.level));
  if (opts.kindNs) conditions.push(eq(reportingEvents.kindNs, opts.kindNs));
  if (opts.tenantId) conditions.push(eq(reportingEvents.tenantId, opts.tenantId));
  if (opts.site) conditions.push(eq(reportingEvents.site, opts.site));
  if (opts.requestId) conditions.push(eq(reportingEvents.requestId, opts.requestId));
  if (opts.after) {
    const { occurredAt, id } = opts.after;
    const keyset = or(
      lt(reportingEvents.occurredAt, occurredAt),
      and(eq(reportingEvents.occurredAt, occurredAt), lt(reportingEvents.id, id)),
    );
    if (keyset) conditions.push(keyset);
  }
  const rows = await db
    .select()
    .from(reportingEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(reportingEvents.occurredAt), desc(reportingEvents.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    next: rows.length > limit && last ? { occurredAt: last.occurredAt, id: last.id } : null,
  };
}
