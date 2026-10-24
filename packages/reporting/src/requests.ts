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

/** A request slower than this many milliseconds counts as slow. */
export const SLOW_REQUEST_MS = 1000;

interface Counts {
  requests: number;
  errors: number;
  durationMsSum: number;
  slow: number;
  signIns: number;
  signInFailures: number;
}

const empty = (): Counts => ({
  requests: 0,
  errors: 0,
  durationMsSum: 0,
  slow: 0,
  signIns: 0,
  signInFailures: 0,
});

function addCounts(to: Counts, from: Partial<Counts>): void {
  for (const k of Object.keys(from) as (keyof Counts)[]) to[k] += from[k] ?? 0;
}

/** The counter `countSignIn` adds to: the one `createReporting` made last. */
let active: RequestCounter | null = null;

/**
 * Counts one sign-in attempt in the current minute bucket and color, for the
 * app to call where it knows the outcome. A no-op until `createReporting` has
 * run; never throws.
 */
export function countSignIn(ok: boolean): void {
  active?.recordSignIn(ok);
}

/**
 * Counts responses in memory and writes one upsert per minute bucket, so a
 * request costs a map increment and the database sees a handful of rows a
 * minute. `errors` is status >= 500. A failed write puts its counts back for
 * the next one; the process dying loses at most `flushEveryMs` of counts.
 * `durationMs` adds to the bucket's duration sum, and a request over
 * `SLOW_REQUEST_MS` counts as slow.
 */
export class RequestCounter {
  private readonly buckets = new Map<number, Counts>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly o: RequestCounterOptions) {
    active = this;
  }

  /** Counts one response; `durationMs` is how long it took, when the caller timed it. */
  record(status: number, durationMs?: number): void {
    const ms =
      durationMs !== undefined && Number.isFinite(durationMs)
        ? Math.max(0, Math.round(durationMs))
        : 0;
    this.add({
      requests: 1,
      errors: status >= 500 ? 1 : 0,
      durationMsSum: ms,
      slow: ms > SLOW_REQUEST_MS ? 1 : 0,
    });
  }

  /** Counts one sign-in attempt; adds no request. */
  recordSignIn(ok: boolean): void {
    this.add(ok ? { signIns: 1 } : { signInFailures: 1 });
  }

  /**
   * Counts one 5xx for a request already counted by `record`, such as a page
   * that threw after the proxy let it through. Adds no request.
   */
  recordError(): void {
    this.add({ errors: 1 });
  }

  private add(c: Partial<Counts>): void {
    const minute = Math.floor(this.o.now().getTime() / 60_000) * 60_000;
    const b = this.buckets.get(minute) ?? empty();
    addCounts(b, c);
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
            durationMsSum: c.durationMsSum,
            slow: c.slow,
            signIns: c.signIns,
            signInFailures: c.signInFailures,
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
            durationMsSum: sql`${reportingRequests.durationMsSum} + excluded.duration_ms_sum`,
            slow: sql`${reportingRequests.slow} + excluded.slow`,
            signIns: sql`${reportingRequests.signIns} + excluded.sign_ins`,
            signInFailures: sql`${reportingRequests.signInFailures} + excluded.sign_in_failures`,
          },
        });
    } catch (error) {
      for (const [minute, c] of taken) {
        const b = this.buckets.get(minute) ?? empty();
        addCounts(b, c);
        this.buckets.set(minute, b);
      }
      this.o.log.error(
        { err: error instanceof Error ? error.name : 'unknown' },
        'reporting: request counter flush failed',
      );
    }
  }
}
