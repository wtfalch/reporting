import { reportingAnalytics } from '../tables.js';
import type { Db } from '../types.js';
import type { Device } from './schema.js';

/** One raw row as the collector or `track` writes it; every field already validated and normalised. */
export interface AnalyticsRow {
  readonly occurredAt: Date;
  readonly receivedAt: Date;
  readonly site: string;
  readonly tenantId: string | null;
  readonly visitorId: string | null;
  readonly sessionId: string | null;
  readonly userId: string | null;
  readonly name: string;
  readonly path: string;
  readonly referrerHost: string | null;
  readonly device: Device;
  readonly country: string | null;
  readonly props: Record<string, string | number | boolean | null>;
}

export async function insertAnalytics(db: Db, rows: readonly AnalyticsRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(reportingAnalytics).values(
    rows.map((r) => ({
      occurredAt: r.occurredAt,
      receivedAt: r.receivedAt,
      site: r.site,
      tenantId: r.tenantId,
      visitorId: r.visitorId,
      sessionId: r.sessionId,
      userId: r.userId,
      name: r.name,
      path: r.path,
      referrerHost: r.referrerHost,
      device: r.device,
      country: r.country,
      props: r.props,
    })),
  );
}
