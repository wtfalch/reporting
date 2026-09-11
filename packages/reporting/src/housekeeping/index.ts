import { eq, sql } from 'drizzle-orm';
import { KIND_PATTERN } from '../schema.js';
import { reportingTasks } from '../tables.js';
import type { Db, Reporting, Settings } from '../types.js';
import { describe } from '../writer.js';

/**
 * The tick, and the claim protocol that lets any number of containers share
 * it without a scheduler.
 *
 * A host calls `tick()` from something that already happens often (the
 * `./next` entry hangs it off the health check the platform sends every ten
 * seconds). The tick debounces itself per process, then for every registered
 * task opens one short transaction: SELECT the task's row FOR UPDATE SKIP
 * LOCKED (no row: another container is deciding about it right now), then
 * one conditional UPDATE that claims it only if it is due and no live lease
 * holds it, stamping a fresh token and a lease. The task runs outside that
 * transaction; renewing the lease and recording completion are UPDATEs fenced
 * on the token, so a superseded worker touches zero rows.
 *
 * All time comparisons use the database's `now()`: two containers do not
 * share a clock. Execution is at least once: a lease that expires under a
 * paused worker lets its replacement start, so every task is idempotent.
 *
 * Not an advisory lock, which is session state on whichever pooled
 * connection served the statement, and would have been released on another.
 */

export interface Task {
  /** `namespace.name`, the same shape as an event kind. */
  readonly name: string;
  /** Cadence, ms. */
  readonly every: number;
  /** How long a claim is honoured before another container may take over, ms. Renew inside a long task. */
  readonly lease: number;
  /** Delay before the next attempt after a failure, ms. */
  readonly retry: number;
  run(ctx: TaskContext): Promise<void>;
}

export interface TaskContext {
  readonly reporting: Reporting;
  readonly db: Db;
  readonly settings: Settings;
  now(): Date;
  /** Extends the lease if this claim still holds. `false` means superseded: stop scheduling work. */
  renew(): Promise<boolean>;
  /** The run must finish, or stop scheduling work, by this instant. */
  readonly deadline: Date;
}

export interface HousekeepingOptions {
  reporting: Reporting;
  db?: Db;
  now?: () => Date;
  /** Per process. Default 60,000 ms. */
  debounceMs?: number;
  /** Tasks run at once. Default 2. */
  concurrency?: number;
}

export interface Housekeeping {
  /** Idempotent by name. The row is created on the next tick. */
  register(task: Task): void;
  /** Never throws. */
  tick(): Promise<void>;
  /** For tests and scripts: run the protocol for one task now, ignoring the debounce. */
  runNow(name: string): Promise<'ran' | 'skipped' | 'failed'>;
  tasks(): readonly Task[];
}

type Outcome = 'ok' | 'error' | 'skipped';

export function createHousekeeping(options: HousekeepingOptions): Housekeeping {
  const { reporting } = options;
  const db = options.db ?? reporting.db;
  const now = options.now ?? (() => new Date());
  const debounceMs = options.debounceMs ?? 60_000;
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const registry = new Map<string, Task>();
  let lastTick = 0;
  let ticking: Promise<void> | null = null;
  let rowsEnsured = false;

  function register(task: Task): void {
    if (!KIND_PATTERN.test(task.name)) {
      throw new Error(`housekeeping: task name "${task.name}" is not namespace.name`);
    }
    registry.set(task.name, task);
    rowsEnsured = false;
  }

  async function ensureRows(): Promise<void> {
    if (rowsEnsured || registry.size === 0) return;
    await db
      .insert(reportingTasks)
      .values([...registry.keys()].map((task) => ({ task })))
      .onConflictDoNothing({ target: reportingTasks.task });
    rowsEnsured = true;
  }

  /** The one transaction that decides. Returns the token when this process now holds the task. */
  async function claim(task: Task): Promise<string | null> {
    return db.transaction(async (tx) => {
      const held = await tx
        .select({ task: reportingTasks.task })
        .from(reportingTasks)
        .where(eq(reportingTasks.task, task.name))
        .for('update', { skipLocked: true });
      if (held.length === 0) return null;
      const claimed = await tx
        .update(reportingTasks)
        .set({
          claimToken: sql`gen_random_uuid()`,
          lastStartedAt: sql`now()`,
          leaseExpiresAt: sql`now() + make_interval(secs => ${task.lease / 1000}::double precision)`,
          lastOutcome: null,
          lastError: null,
        })
        .where(
          sql`${reportingTasks.task} = ${task.name}
            and ${reportingTasks.nextDueAt} <= now()
            and (${reportingTasks.leaseExpiresAt} is null or ${reportingTasks.leaseExpiresAt} < now())`,
        )
        .returning({ token: reportingTasks.claimToken });
      return claimed[0]?.token ?? null;
    });
  }

  async function renew(task: Task, token: string): Promise<boolean> {
    const rows = await db
      .update(reportingTasks)
      .set({
        leaseExpiresAt: sql`now() + make_interval(secs => ${task.lease / 1000}::double precision)`,
      })
      .where(sql`${reportingTasks.task} = ${task.name} and ${reportingTasks.claimToken} = ${token}`)
      .returning({ task: reportingTasks.task });
    return rows.length === 1;
  }

  async function complete(
    task: Task,
    token: string,
    outcome: Outcome,
    error: string | null,
  ): Promise<void> {
    const delay = (outcome === 'error' ? task.retry : task.every) / 1000;
    await db
      .update(reportingTasks)
      .set({
        lastFinishedAt: sql`now()`,
        leaseExpiresAt: null,
        nextDueAt: sql`now() + make_interval(secs => ${delay}::double precision)`,
        lastOutcome: outcome,
        lastError: error ? error.slice(0, 512) : null,
      })
      .where(
        sql`${reportingTasks.task} = ${task.name} and ${reportingTasks.claimToken} = ${token}`,
      );
  }

  async function runClaimed(task: Task, token: string, settings: Settings): Promise<Outcome> {
    const started = now();
    const deadline = new Date(started.getTime() + task.lease);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${task.lease} ms`)), task.lease);
      timer.unref?.();
    });
    try {
      await Promise.race([
        task.run({
          reporting,
          db,
          settings,
          now,
          renew: () => renew(task, token),
          deadline,
        }),
        timeout,
      ]);
      await complete(task, token, 'ok', null);
      reporting.event({
        kind: 'housekeeping.task_ran',
        message: `${task.name} ran in ${now().getTime() - started.getTime()} ms`,
        data: { task: task.name, ms: now().getTime() - started.getTime() },
      });
      return 'ok';
    } catch (error) {
      const text = describe(error);
      await complete(task, token, 'error', text).catch(() => undefined);
      reporting.event({
        kind: 'housekeeping.task_failed',
        level: 'error',
        message: `${task.name} failed: ${text}`.slice(0, 512),
        data: { task: task.name, error: text.slice(0, 200) },
      });
      return 'error';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function runOne(task: Task, settings: Settings): Promise<Outcome> {
    const token = await claim(task);
    if (!token) return 'skipped';
    return runClaimed(task, token, settings);
  }

  async function tickNow(): Promise<void> {
    await ensureRows();
    const settings = await reporting.settings.get();
    const queue = [...registry.values()];
    const counts = { claimed: 0, skipped: 0, ran: 0, failed: 0 };
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let task = queue.shift(); task; task = queue.shift()) {
        try {
          const outcome = await runOne(task, settings);
          if (outcome === 'skipped') counts.skipped += 1;
          else {
            counts.claimed += 1;
            if (outcome === 'ok') counts.ran += 1;
            else counts.failed += 1;
          }
        } catch (error) {
          // The claim itself failed (the database was away). Nothing to
          // complete; the row is untouched and the next tick tries again.
          counts.skipped += 1;
          reporting.log.error(
            { err: describe(error), task: task.name },
            'housekeeping: claim failed',
          );
        }
      }
    });
    await Promise.all(workers);
    if (counts.claimed > 0) {
      reporting.event({
        kind: 'housekeeping.tick',
        message: `tick: ${counts.ran} ran, ${counts.failed} failed, ${counts.skipped} skipped`,
        data: counts,
      });
    }
    await reporting.flush({ deadlineMs: 5000 });
  }

  return {
    register,
    tasks: () => [...registry.values()],
    async tick() {
      const t = Date.now();
      if (ticking) return ticking;
      if (t - lastTick < debounceMs) return;
      lastTick = t;
      ticking = tickNow()
        .catch((error) => {
          reporting.log.error({ err: describe(error) }, 'housekeeping: tick failed');
        })
        .finally(() => {
          ticking = null;
        });
      return ticking;
    },
    async runNow(name) {
      const task = registry.get(name);
      if (!task) throw new Error(`housekeeping: no task "${name}"`);
      await ensureRows();
      const settings = await reporting.settings.get();
      const outcome = await runOne(task, settings);
      await reporting.flush({ deadlineMs: 5000 });
      return outcome === 'ok' ? 'ran' : outcome === 'skipped' ? 'skipped' : 'failed';
    },
  };
}

export { pruneEvents, retentionLag } from './tasks.js';
