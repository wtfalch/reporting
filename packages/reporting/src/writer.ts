import { type ValidEvent, eventInputSchema } from './schema.js';
import { reportingEvents } from './tables.js';
import type { Db, EventInput, Logger, Mode, Stats } from './types.js';

/**
 * The queue behind `event()`.
 *
 * Every accepted event is a logger line first, so the container log stays
 * complete whatever happens below. The database copy is best effort: rows
 * are queued and flushed in one multi-row insert after the current unit of
 * work (`defer`, which is `after()` under Next) and on a timer, so the last
 * row of a quiet period is not stranded. A flush that fails leaves its rows
 * queued, up to the bound, and says so on the logger; nothing in here throws
 * to a caller in production.
 *
 * Validation failures are the one exception, and only outside production: a
 * banned key or a nested payload is a programmer error worth a stack trace
 * on a laptop and in CI, and worth exactly one `reporting.invalid` row and a
 * logger error in production, where a log line must never fail a request.
 */

type Row = typeof reportingEvents.$inferInsert;

export interface WriterOptions {
  db: Db;
  log: Logger;
  site: string;
  mode: Mode;
  now: () => Date;
  defer: (fn: () => Promise<void>) => void;
  queueLimit: number;
  batchSize: number;
  flushEveryMs: number;
}

export class Writer {
  private readonly queue: Row[] = [];
  private inFlight: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deferred = false;
  private dropped = 0;
  private droppedSinceReport = 0;
  private invalid = 0;
  private flushed = 0;
  private failedFlushes = 0;

  constructor(private readonly o: WriterOptions) {}

  event(input: EventInput): void {
    const parsed = eventInputSchema.safeParse(input);
    if (!parsed.success) {
      this.invalid += 1;
      const issue = parsed.error.issues[0];
      const where = issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid';
      if (this.o.mode !== 'production') {
        throw new Error(`reporting.event refused: ${where}`);
      }
      // The offending payload is exactly what must not be written; the
      // kind, if it is even a string, and the failing path are enough.
      const kind = typeof input?.kind === 'string' ? input.kind.slice(0, 128) : '(not a string)';
      this.o.log.error({ kind, issue: where }, 'reporting: event refused');
      this.enqueue(
        this.toRow({
          kind: 'reporting.invalid',
          level: 'error',
          message: `event refused: ${where}`.slice(0, 512),
          data: { kind },
          tenantId: null,
          actor: null,
          requestId: null,
          target: null,
        }),
      );
      return;
    }
    const row = this.toRow(parsed.data);
    this.o.log[parsed.data.level === 'alert' ? 'warn' : parsed.data.level](
      {
        site: row.site,
        kind: row.kind,
        tenantId: row.tenantId,
        requestId: row.requestId,
        data: row.data,
      },
      row.message,
    );
    this.enqueue(row);
  }

  private toRow(v: Omit<ValidEvent, 'occurredAt'> & { occurredAt?: Date }): Row {
    return {
      occurredAt: v.occurredAt ?? this.o.now(),
      level: v.level,
      kind: v.kind,
      site: this.o.site,
      tenantId: v.tenantId ?? null,
      actorClass: v.actor?.class ?? null,
      actorId: v.actor?.id ?? null,
      requestId: v.requestId ?? null,
      targetType: v.target?.type ?? null,
      targetId: v.target?.id ?? null,
      message: v.message,
      data: v.data,
    };
  }

  private enqueue(row: Row): void {
    if (this.queue.length >= this.o.queueLimit) {
      this.dropped += 1;
      this.droppedSinceReport += 1;
      return;
    }
    this.queue.push(row);
    this.schedule();
  }

  /** Once per idle period through `defer`, and always on the timer. */
  private schedule(): void {
    if (!this.deferred) {
      this.deferred = true;
      try {
        this.o.defer(() => this.flush({ deadlineMs: 5000 }));
      } catch (error) {
        // A host's defer that throws (called outside a request scope, say)
        // must not take the event with it; the timer still runs.
        this.o.log.warn({ err: describe(error) }, 'reporting: defer threw; relying on the timer');
      }
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush({ deadlineMs: 5000 });
      }, this.o.flushEveryMs);
      this.timer.unref?.();
    }
  }

  /**
   * Drain until the queue is empty and nothing is in flight, or the deadline.
   * Two callers overlap all the time (the timer and a request's `after()`,
   * the tick and its own timer), so "empty" is not enough: a row another
   * flush spliced off the queue a moment ago is still on its way, and a
   * caller that returned on an empty queue would read the table too early.
   * Every caller therefore waits for whatever is in flight and looks again.
   */
  async flush(opts: { deadlineMs?: number } = {}): Promise<void> {
    const deadline = Date.now() + (opts.deadlineMs ?? 5000);
    while (Date.now() < deadline) {
      if (this.inFlight) {
        await this.inFlight;
        continue;
      }
      if (this.queue.length === 0) break;
      const attempt = this.flushOnce();
      this.inFlight = attempt;
      let ok = false;
      try {
        ok = await attempt;
      } finally {
        if (this.inFlight === attempt) this.inFlight = null;
      }
      // A failed insert leaves its rows queued; do not spin on the database
      // inside one call. The timer and the next defer try again.
      if (!ok) break;
    }
    this.deferred = false;
  }

  /** One insert of one batch. Resolves true on success; never throws. */
  private async flushOnce(): Promise<boolean> {
    const batch = this.queue.splice(0, this.o.batchSize);
    if (this.droppedSinceReport > 0) {
      const count = this.droppedSinceReport;
      this.droppedSinceReport = 0;
      batch.push(
        this.toRow({
          kind: 'reporting.dropped',
          level: 'warn',
          message: `${count} event(s) went to the logger only: the queue was full`,
          data: { count },
          tenantId: null,
          actor: null,
          requestId: null,
          target: null,
        }),
      );
    }
    try {
      await this.o.db.insert(reportingEvents).values(batch);
      this.flushed += batch.length;
      return true;
    } catch (error) {
      this.failedFlushes += 1;
      // Back at the front, so order survives; the bound still applies, and
      // whatever does not fit is counted as dropped rather than kept for ever.
      const room = Math.max(0, this.o.queueLimit - this.queue.length);
      const kept = batch.slice(0, room);
      this.dropped += batch.length - kept.length;
      this.droppedSinceReport += batch.length - kept.length;
      this.queue.unshift(...kept);
      this.o.log.error(
        { err: describe(error), rows: batch.length, queued: this.queue.length },
        'reporting: flush failed; rows stay queued',
      );
      return false;
    }
  }

  stats(): Stats {
    return {
      queued: this.queue.length,
      dropped: this.dropped,
      invalid: this.invalid,
      flushed: this.flushed,
      failedFlushes: this.failedFlushes,
    };
  }
}

/** A string for the logger, never the error object: an error's `cause` can carry a request body. */
export function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 500);
  return String(error).slice(0, 500);
}
