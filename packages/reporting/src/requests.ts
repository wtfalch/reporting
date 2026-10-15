import { sql } from 'drizzle-orm';
import { deployTags } from './deploy.js';
import { reportingRequests } from './tables.js';
import type { Db, Logger } from './types.js';

export interface RequestCounterOptions {
  db: Db;
  log: Logger;
  site: string;
  now: () => Date;
  flushEveryMs: number;
}

/**
 * Counts responses in memory and writes one upsert per minute bucket, so a
 * request costs a map increment and the database sees a handful of rows a
 * minute. `errors` is status >= 500. A failed write puts its counts back for
 * the next one; the process dying loses at most `flushEveryMs` of counts.
 */
export class RequestCounter {
  private readonly buckets = new Map<number, { requests: number; errors: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly o: RequestCounterOptions) {}

  record(status: number): void {
    const minute = Math.floor(this.o.now().getTime() / 60_000) * 60_000;
    const b = this.buckets.get(minute) ?? { requests: 0, errors: 0 };
    b.requests += 1;
    if (status >= 500) b.errors += 1;
    this.buckets.set(minute, b);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.o.flushEveryMs);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.buckets.size === 0) return;
    const taken = [...this.buckets];
    this.buckets.clear();
    const { color, release } = deployTags();
    try {
      await this.o.db
        .insert(reportingRequests)
        .values(
          taken.map(([minute, c]) => ({
            bucket: new Date(minute),
            site: this.o.site,
            color: color ?? '',
            release: release ?? '',
            requests: c.requests,
            errors: c.errors,
          })),
        )
        .onConflictDoUpdate({
          target: [
            reportingRequests.bucket,
            reportingRequests.site,
            reportingRequests.color,
            reportingRequests.release,
          ],
          set: {
            requests: sql`${reportingRequests.requests} + excluded.requests`,
            errors: sql`${reportingRequests.errors} + excluded.errors`,
          },
        });
    } catch (error) {
      for (const [minute, c] of taken) {
        const b = this.buckets.get(minute) ?? { requests: 0, errors: 0 };
        b.requests += c.requests;
        b.errors += c.errors;
        this.buckets.set(minute, b);
      }
      this.o.log.error(
        { err: error instanceof Error ? error.name : 'unknown' },
        'reporting: request counter flush failed',
      );
    }
  }
}
