import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type {
  RecentEvent,
  RecentOptions,
  SeriesOptions,
  SeriesPoint,
  WeeklyPoint,
} from './analytics/reader.js';
import type { Device } from './analytics/schema.js';
import type { Actor, EventInput, FlatData, Level } from './schema.js';
import type { ReportingEventRow, tables } from './tables.js';

/**
 * The host's drizzle handle, whatever driver it runs on. postgres-js in the
 * apps, PGlite in this package's own tests; the queries here use nothing
 * driver-specific.
 */
// biome-ignore lint/suspicious/noExplicitAny: the host's schema is the host's; this package indexes none of it.
export type Db = PgDatabase<PgQueryResultHKT, any, any>;

/** pino-shaped, so a host passes its logger and this package depends on none. */
export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export type Mode = 'production' | 'development' | 'test';

/** What `alert()` takes: the shape the template's `alerts.ts` already produces. */
export interface AlertFinding {
  readonly check: string;
  readonly message: string;
  readonly detail?: unknown;
}

/** A settings change handed to the host's audit writer, when it bound one. */
export interface SettingsChange {
  readonly before: Settings;
  readonly after: Settings;
  readonly by: Actor;
  readonly changed: readonly string[];
}

export type ConsentMode = 'none' | 'consented' | 'always';
export interface Settings {
  readonly 'events.retention_days': number;
  readonly 'analytics.retention_days': number;
  readonly 'analytics.consent': ConsentMode;
  readonly 'analytics.identify_signed_in': boolean;
}

export interface ReportingOptions {
  db: Db;
  log: Logger;
  /** This host's id, stamped on every row: `^[a-z][a-z0-9-]{0,63}$`. */
  site: string;
  /**
   * Runs a flush after the current unit of work. The `./next` entry passes
   * `after()`; the default is `setTimeout(0)`, which a script keeps until it
   * exits. Errors thrown by `fn` are the flush's own and never reach here.
   */
  defer?: (fn: () => Promise<void>) => void;
  now?: () => Date;
  /** Defaults from NODE_ENV: anything but `development` or `test` is production. */
  mode?: Mode;
  /** The host's second sink (Sentry, say). Called after the row is queued; a throw is swallowed. */
  onAlert?: (finding: AlertFinding) => void;
  /** Bound by the host to its audit ledger; called after a settings change commits. */
  audit?: (change: SettingsChange) => Promise<void>;
  /** The host's route normalisation for analytics paths (addendum A7); the package's default otherwise. */
  normalisePath?: (pathname: string) => string;
  /** Queue bound; past it rows go to the logger only. Default 1,000. */
  queueLimit?: number;
  /** Rows per insert. Default 500. */
  batchSize?: number;
  /** Timer flush interval, ms. Default 1,000. */
  flushEveryMs?: number;
}

export interface EventsPageOptions {
  readonly limit?: number;
  readonly after?: { readonly occurredAt: Date; readonly id: number };
  readonly level?: Level;
  readonly kindNs?: string;
  readonly tenantId?: string;
  readonly site?: string;
  readonly requestId?: string;
}

export interface EventsPage {
  readonly items: readonly ReportingEventRow[];
  readonly next: { readonly occurredAt: Date; readonly id: number } | null;
}

export interface Stats {
  readonly queued: number;
  readonly dropped: number;
  readonly invalid: number;
  readonly flushed: number;
}

/** A server-side analytics event: the server's truth about something a person did, with identity from the `Access`, never a claim. */
export interface TrackInput {
  readonly name: string;
  readonly props?: Record<string, string | number | boolean | null>;
  readonly tenantId?: string | null;
  /** The signed-in person's id, from the host's resolved principal. */
  readonly userId?: string | null;
  /** The pathname the event belongs to; normalised before storage. Default `/`. */
  readonly path?: string;
  readonly device?: Device;
  readonly country?: string | null;
  /** The consent cookie's value, when the host passes it through. */
  readonly visitorId?: string | null;
  readonly sessionId?: string | null;
  readonly occurredAt?: Date;
}

export interface Analytics {
  /** Never throws in production: a failed insert is a log line. */
  track(input: TrackInput): Promise<void>;
  series(opts: SeriesOptions): Promise<readonly SeriesPoint[]>;
  weekly(opts: { site: string; tenantId?: string; from: string; to: string }): Promise<
    readonly WeeklyPoint[]
  >;
  recent(opts: RecentOptions): Promise<readonly RecentEvent[]>;
}

export interface Reporting {
  /** Never throws in production; see writer.ts. */
  event(input: EventInput): void;
  /** An `alert.<check>` row at level `alert`, then the host's `onAlert`. */
  alert(finding: AlertFinding): void;
  /** Drain the queue now. Bounded by `deadlineMs` (default 5,000). Never throws. */
  flush(opts?: { deadlineMs?: number }): Promise<void>;
  readonly events: { page(opts?: EventsPageOptions): Promise<EventsPage> };
  readonly settings: {
    get(): Promise<Settings>;
    set(patch: Partial<Settings>, by: Actor): Promise<SettingsChange>;
  };
  readonly tables: typeof tables;
  readonly site: string;
  readonly log: Logger;
  readonly analytics: Analytics;
  stats(): Stats;
}

export type { Actor, EventInput, FlatData, Level };
