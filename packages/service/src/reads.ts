import {
  ACTOR_CLASSES,
  type Actor,
  type Db,
  ERROR_RUNTIMES,
  ERROR_STATES,
  type ErrorRuntime,
  type ErrorState,
  FINGERPRINT_PATTERN,
  type ReportingErrorRow,
  errorDetail,
  errorsPage,
  reportingErrors,
  reportingEvents,
  setErrorState,
} from '@wtfalch/reporting-core';
import { and, desc, eq, gte, ilike, inArray, like, lt, or, sql } from 'drizzle-orm';
import { writeAudit } from './audit.js';
import { ServiceError } from './errors.js';
import {
  CONTEXT_ID_PATTERN,
  CONTEXT_KEYS,
  type ContextCount,
  type ContextKey,
  ENVIRONMENTS,
  type ErrorGroup,
  type ErrorSeries,
  type ErrorsList,
  INGEST_LIMITS,
  type ReportingEnvironment,
  SITE_PATTERN,
  type SeriesBucket,
} from './schema.js';

/** `limit` on the list: 1 to 100, 50 when absent. */
export const LIST_LIMIT = { min: 1, max: 100, default: 50 } as const;
/** `bucket` on the series, in minutes: 60 (the default) or 1440. */
export const SERIES_BUCKETS = [60, 1440] as const;
/** The longest range a series covers. */
export const MAX_SERIES_DAYS = 31;
/** Most context ids an `ErrorGroup.contexts` lists per key, and most items a by-context read returns. */
export const CONTEXTS_PER_KEY = 20;
export const BY_CONTEXT_LIMIT = 100;

/** Filters on the opaque ids an `error.*` event carries in `data.context`. */
export type ContextFilter = Partial<Record<ContextKey, string>>;

/** The flat key a context id is stored under in `reporting_events.data` (the table refuses nested data). */
const DATA_KEY: Record<ContextKey, string> = {
  company: 'contextCompany',
  mcp: 'contextMcp',
  account: 'contextAccount',
};
// The key is one of three constants, inlined so repeated uses in one aggregate are the same expression.
const ctx = (key: ContextKey) =>
  sql<string | null>`(${reportingEvents.data}->>${sql.raw(`'${DATA_KEY[key]}'`)})`;

/** `error.*` rows of a site that carry every id in `filter`. */
function contextEventConditions(site: string, filter: ContextFilter) {
  const conditions = [
    eq(reportingEvents.level, 'error'),
    like(reportingEvents.kind, 'error.%'),
    eq(reportingEvents.site, site),
  ];
  for (const key of CONTEXT_KEYS) {
    const value = filter[key];
    if (value !== undefined) conditions.push(sql`${ctx(key)} = ${value}`);
  }
  return conditions;
}

const NO_CONTEXTS = { company: [], mcp: [], account: [] } as const;

/**
 * Per group: the distinct context ids on its `error.*` rows (sorted, at most
 * 20 per key) and how many of those rows carry `retryOf`.
 */
export async function contextsOf(
  db: Db,
  site: string,
  fingerprints: readonly string[],
): Promise<Map<string, { contexts: ErrorGroup['contexts']; retries: number }>> {
  if (fingerprints.length === 0) return new Map();
  const fp = sql<string>`${reportingEvents.data}->>'fingerprint'`;
  const ids = (key: ContextKey) =>
    sql<
      string[] | null
    >`(array_agg(distinct ${ctx(key)} order by ${ctx(key)}) filter (where ${ctx(key)} is not null))[1:${CONTEXTS_PER_KEY}]`;
  const rows = await db
    .select({
      fingerprint: fp,
      company: ids('company'),
      mcp: ids('mcp'),
      account: ids('account'),
      retries:
        sql<number>`count(*) filter (where ${reportingEvents.data} ? 'retryOf')::int`.mapWith(
          Number,
        ),
    })
    .from(reportingEvents)
    .where(
      and(
        eq(reportingEvents.level, 'error'),
        like(reportingEvents.kind, 'error.%'),
        eq(reportingEvents.site, site),
        inArray(fp, [...fingerprints]),
      ),
    )
    .groupBy(fp);
  return new Map(
    rows.map((r) => [
      r.fingerprint,
      {
        contexts: { company: r.company ?? [], mcp: r.mcp ?? [], account: r.account ?? [] },
        retries: r.retries,
      },
    ]),
  );
}

function actorOf(resolvedBy: string | null): Actor | null {
  if (!resolvedBy) return null;
  const at = resolvedBy.indexOf(':');
  if (at <= 0) return null;
  const cls = resolvedBy.slice(0, at);
  if (!(ACTOR_CLASSES as readonly string[]).includes(cls)) return null;
  return { class: cls as Actor['class'], id: resolvedBy.slice(at + 1) };
}

/**
 * Different people per group, from the `person` hash on its `error.*`
 * timeline rows (ingest.ts, `personHash`). A group none of whose rows names
 * a person is absent, which the caller reads as `null`.
 */
export async function peopleOf(
  db: Db,
  site: string,
  fingerprints: readonly string[],
): Promise<Map<string, number>> {
  if (fingerprints.length === 0) return new Map();
  const fp = sql<string>`${reportingEvents.data}->>'fingerprint'`;
  const rows = await db
    .select({
      fingerprint: fp,
      n: sql<number>`count(distinct ${reportingEvents.data}->>'person')::int`.mapWith(Number),
    })
    .from(reportingEvents)
    .where(
      and(
        eq(reportingEvents.level, 'error'),
        like(reportingEvents.kind, 'error.%'),
        eq(reportingEvents.site, site),
        inArray(fp, [...fingerprints]),
        sql`${reportingEvents.data} ? 'person'`,
      ),
    )
    .groupBy(fp);
  return new Map(rows.map((r) => [r.fingerprint, r.n]));
}

/** A stored group as the contract's `ErrorGroup`. Color and the tenant stay in. */
export function toErrorGroup(
  row: ReportingErrorRow,
  people: number | null = null,
  extra: { contexts: ErrorGroup['contexts']; retries: number } = {
    contexts: NO_CONTEXTS,
    retries: 0,
  },
): ErrorGroup {
  return {
    fingerprint: row.fingerprint,
    site: row.site,
    environment: row.environment ?? '',
    kind: row.kind,
    message: row.message,
    stack: row.stack,
    runtime: row.runtime as ErrorRuntime,
    release: row.release,
    occurrences: Number(row.occurrences),
    firstSeenAt: new Date(row.firstSeenAt).toISOString(),
    lastSeenAt: new Date(row.lastSeenAt).toISOString(),
    requestId: row.requestId,
    state: row.state as ErrorState,
    resolvedAt: row.resolvedAt ? new Date(row.resolvedAt).toISOString() : null,
    resolvedBy: actorOf(row.resolvedBy),
    people,
    contexts: extra.contexts,
    retries: extra.retries,
  };
}

/** The opaque `next`: the keyset core pages on, `(lastSeenAt, fingerprint)`. */
export function encodeCursor(after: { lastSeenAt: Date; fingerprint: string }): string {
  return Buffer.from(
    JSON.stringify([new Date(after.lastSeenAt).toISOString(), after.fingerprint]),
  ).toString('base64url');
}

export function decodeCursor(cursor: string): { lastSeenAt: Date; fingerprint: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      typeof value[1] === 'string' &&
      FINGERPRINT_PATTERN.test(value[1])
    ) {
      const lastSeenAt = new Date(value[0]);
      if (!Number.isNaN(lastSeenAt.getTime())) return { lastSeenAt, fingerprint: value[1] };
    }
  } catch {
    // falls through to the refusal
  }
  throw new ServiceError('invalid_request', 'after is not a cursor this service gave out');
}

export interface ListOptions {
  readonly site: string;
  readonly environment?: ReportingEnvironment;
  readonly state?: ErrorState;
  readonly runtime?: ErrorRuntime;
  readonly search?: string;
  readonly limit?: number;
  readonly after?: string;
  readonly context?: ContextFilter;
}

function hasContext(filter: ContextFilter | undefined): filter is ContextFilter {
  return filter !== undefined && CONTEXT_KEYS.some((key) => filter[key] !== undefined);
}

/**
 * `errorsPage` with a context filter. Core's page has no hook for one, so
 * this pages `reporting_errors` the same way (newest `lastSeenAt` first,
 * keyset on `(lastSeenAt, fingerprint)`), keeping only groups with an event
 * that carries every id asked for.
 */
async function filteredPage(
  db: Db,
  o: ListOptions,
  context: ContextFilter,
): Promise<{ items: ReportingErrorRow[]; next: { lastSeenAt: Date; fingerprint: string } | null }> {
  const errors = reportingErrors;
  const limit = o.limit ?? LIST_LIMIT.default;
  const conditions = [eq(errors.site, o.site), eq(errors.state, o.state ?? 'open')];
  if (o.runtime) conditions.push(eq(errors.runtime, o.runtime));
  if (o.environment) conditions.push(eq(errors.environment, o.environment));
  const search = o.search?.trim().slice(0, 200);
  if (search) {
    const pattern = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const clause = or(ilike(errors.message, pattern), ilike(errors.stack, pattern));
    if (clause) conditions.push(clause);
  }
  if (o.after !== undefined) {
    const { lastSeenAt, fingerprint } = decodeCursor(o.after);
    const keyset = or(
      lt(errors.lastSeenAt, lastSeenAt),
      and(eq(errors.lastSeenAt, lastSeenAt), lt(errors.fingerprint, fingerprint)),
    );
    if (keyset) conditions.push(keyset);
  }
  const matching = db
    .select({ fp: sql<string>`${reportingEvents.data}->>'fingerprint'` })
    .from(reportingEvents)
    .where(and(...contextEventConditions(o.site, context)));
  conditions.push(inArray(errors.fingerprint, matching));
  const rows = await db
    .select()
    .from(errors)
    .where(and(...conditions))
    .orderBy(desc(errors.lastSeenAt), desc(errors.fingerprint))
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

/** Newest `lastSeenAt` first, keyset-paged, over core's `errorsPage`. */
export async function listErrors(db: Db, o: ListOptions): Promise<ErrorsList> {
  const page = hasContext(o.context)
    ? await filteredPage(db, o, o.context)
    : await errorsPage(db, {
        site: o.site,
        environment: o.environment,
        state: o.state ?? 'open',
        runtime: o.runtime,
        search: o.search,
        limit: o.limit ?? LIST_LIMIT.default,
        after: o.after === undefined ? undefined : decodeCursor(o.after),
      });
  const items = page.items as readonly ReportingErrorRow[];
  const fingerprints = items.map((row) => row.fingerprint);
  const people = await peopleOf(db, o.site, fingerprints);
  const extras = await contextsOf(db, o.site, fingerprints);
  return {
    items: items.map((row) =>
      toErrorGroup(row, people.get(row.fingerprint) ?? null, extras.get(row.fingerprint)),
    ),
    next: page.next ? encodeCursor(page.next) : null,
  };
}

/** One group of this site, or null. A group of another site is not this one. */
export async function getError(
  db: Db,
  site: string,
  fingerprint: string,
  context?: ContextFilter,
): Promise<ErrorGroup | null> {
  if (!FINGERPRINT_PATTERN.test(fingerprint)) return null;
  const row = await errorDetail(db, fingerprint);
  if (!row || row.site !== site) return null;
  if (hasContext(context)) {
    const [hit] = await db
      .select({ one: sql<number>`1` })
      .from(reportingEvents)
      .where(
        and(
          ...contextEventConditions(site, context),
          sql`${reportingEvents.data}->>'fingerprint' = ${fingerprint}`,
        ),
      )
      .limit(1);
    if (!hit) return null;
  }
  const people = await peopleOf(db, site, [fingerprint]);
  const extras = await contextsOf(db, site, [fingerprint]);
  return toErrorGroup(row, people.get(fingerprint) ?? null, extras.get(fingerprint));
}

/**
 * Moves a group's state through core's `setErrorState` and writes the audit
 * row in the same transaction. `resolved` and `ignored` stamp who and when;
 * `open` clears both. Null for an unknown group or one of another site.
 */
export async function setState(
  db: Db,
  tenantId: string | null,
  input: { site: string; fingerprint: string; state: ErrorState; by: Actor },
): Promise<ErrorGroup | null> {
  if (!FINGERPRINT_PATTERN.test(input.fingerprint)) return null;
  return db.transaction(async (tx) => {
    const current = await errorDetail(tx, input.fingerprint);
    if (!current || current.site !== input.site) return null;
    const row = await setErrorState(tx, input.fingerprint, input.state, input.by);
    if (!row) return null;
    await writeAudit(tx, tenantId, {
      operation: 'error.state',
      site: input.site,
      fingerprint: input.fingerprint,
      state: input.state,
      by: input.by,
    });
    const people = await peopleOf(tx, input.site, [input.fingerprint]);
    const extras = await contextsOf(tx, input.site, [input.fingerprint]);
    return toErrorGroup(row, people.get(input.fingerprint) ?? null, extras.get(input.fingerprint));
  });
}

export interface SeriesOptions {
  readonly site: string;
  readonly environment?: ReportingEnvironment;
  readonly from: Date;
  readonly to: Date;
  readonly bucketMinutes: (typeof SERIES_BUCKETS)[number];
  readonly fingerprint?: string;
  readonly context?: ContextFilter;
}

/**
 * Error occurrences per bucket from the `error.*` rows in `reporting_events`
 * (the timeline row every capture writes, `data: { fingerprint, runtime }`).
 * Buckets start at `from` and run to `to`; every one is present, zeros
 * included. Counts every occurrence, also of groups since resolved.
 */
export async function errorSeries(db: Db, o: SeriesOptions): Promise<ErrorSeries> {
  const ms = o.bucketMinutes * 60_000;
  const count = Math.ceil((o.to.getTime() - o.from.getTime()) / ms);
  const fromSeconds = o.from.getTime() / 1000;
  const conditions = [
    eq(reportingEvents.level, 'error'),
    like(reportingEvents.kind, 'error.%'),
    eq(reportingEvents.site, o.site),
    gte(reportingEvents.occurredAt, o.from),
    lt(reportingEvents.occurredAt, o.to),
  ];
  if (o.environment) conditions.push(eq(reportingEvents.environment, o.environment));
  if (o.fingerprint) {
    conditions.push(sql`${reportingEvents.data}->>'fingerprint' = ${o.fingerprint}`);
  }
  for (const key of CONTEXT_KEYS) {
    const value = o.context?.[key];
    if (value !== undefined) conditions.push(sql`${ctx(key)} = ${value}`);
  }
  const rows = await db
    .select({
      i: sql<number>`floor((extract(epoch from ${reportingEvents.occurredAt}) - ${fromSeconds}::double precision) / ${o.bucketMinutes * 60}::double precision)::int`.mapWith(
        Number,
      ),
      n: sql<number>`count(*)::int`.mapWith(Number),
    })
    .from(reportingEvents)
    .where(and(...conditions))
    .groupBy(sql`1`);
  const counts = new Map(rows.map((row) => [row.i, row.n]));
  const buckets: SeriesBucket[] = [];
  for (let i = 0; i < count; i++) {
    buckets.push({
      start: new Date(o.from.getTime() + i * ms).toISOString(),
      errors: counts.get(i) ?? 0,
    });
  }
  return { bucketMinutes: o.bucketMinutes, buckets };
}

export interface ByContextOptions {
  readonly site: string;
  readonly environment?: ReportingEnvironment;
  readonly from: Date;
  readonly to: Date;
  readonly by: ContextKey;
}

/**
 * Errors per context id over `[from, to)`: events carrying an id under `by`,
 * and how many different groups they fall in. Most errors first, 100 at most.
 */
export async function errorsByContext(db: Db, o: ByContextOptions): Promise<ContextCount[]> {
  const id = ctx(o.by);
  const conditions = [
    eq(reportingEvents.level, 'error'),
    like(reportingEvents.kind, 'error.%'),
    eq(reportingEvents.site, o.site),
    gte(reportingEvents.occurredAt, o.from),
    lt(reportingEvents.occurredAt, o.to),
    sql`${id} is not null`,
  ];
  if (o.environment) conditions.push(eq(reportingEvents.environment, o.environment));
  const errors = sql<number>`count(*)::int`;
  const rows = await db
    .select({
      id,
      errors: errors.mapWith(Number),
      groups: sql<number>`count(distinct ${reportingEvents.data}->>'fingerprint')::int`.mapWith(
        Number,
      ),
    })
    .from(reportingEvents)
    .where(and(...conditions))
    .groupBy(id)
    .orderBy(desc(errors), id)
    .limit(BY_CONTEXT_LIMIT);
  return rows.map((r) => ({ id: r.id ?? '', errors: r.errors, groups: r.groups }));
}

/** The query-string readers the handler uses; each refuses with `invalid_request`. */
export const params = {
  site(url: URL): string {
    const site = url.searchParams.get('site');
    if (!site || !SITE_PATTERN.test(site)) {
      throw new ServiceError('invalid_request', 'site is required');
    }
    return site;
  },
  environment(url: URL): ReportingEnvironment | undefined {
    const value = url.searchParams.get('environment');
    if (value === null || value === '') return undefined;
    if (!(ENVIRONMENTS as readonly string[]).includes(value)) {
      throw new ServiceError('invalid_request', 'environment must be production or stage');
    }
    return value as ReportingEnvironment;
  },
  state(url: URL): ErrorState | undefined {
    const value = url.searchParams.get('state');
    if (value === null || value === '') return undefined;
    if (!(ERROR_STATES as readonly string[]).includes(value)) {
      throw new ServiceError('invalid_request', 'state must be open, resolved or ignored');
    }
    return value as ErrorState;
  },
  runtime(url: URL): ErrorRuntime | undefined {
    const value = url.searchParams.get('runtime');
    if (value === null || value === '') return undefined;
    if (!(ERROR_RUNTIMES as readonly string[]).includes(value)) {
      throw new ServiceError('invalid_request', 'runtime must be server, edge or browser');
    }
    return value as ErrorRuntime;
  },
  limit(url: URL): number | undefined {
    const value = url.searchParams.get('limit');
    if (value === null || value === '') return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < LIST_LIMIT.min || n > LIST_LIMIT.max) {
      throw new ServiceError('invalid_request', 'limit must be a whole number from 1 to 100');
    }
    return n;
  },
  time(url: URL, name: 'from' | 'to'): Date {
    const value = url.searchParams.get(name);
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) {
      throw new ServiceError('invalid_request', `${name} must be an ISO time`);
    }
    return date;
  },
  bucket(url: URL): (typeof SERIES_BUCKETS)[number] {
    const value = url.searchParams.get('bucket');
    if (value === null || value === '') return 60;
    const n = Number(value);
    if (!(SERIES_BUCKETS as readonly number[]).includes(n)) {
      throw new ServiceError('invalid_request', 'bucket must be 60 or 1440');
    }
    return n as (typeof SERIES_BUCKETS)[number];
  },
  context(url: URL): ContextFilter | undefined {
    const out: ContextFilter = {};
    for (const key of CONTEXT_KEYS) {
      const value = url.searchParams.get(key);
      if (value === null || value === '') continue;
      if (value.length > INGEST_LIMITS.contextId || !CONTEXT_ID_PATTERN.test(value)) {
        throw new ServiceError(
          'invalid_request',
          `${key} must be 1 to 128 characters of letters, digits, _ . : -`,
        );
      }
      out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  },
  by(url: URL): ContextKey {
    const value = url.searchParams.get('by');
    if (!(CONTEXT_KEYS as readonly string[]).includes(value ?? '')) {
      throw new ServiceError('invalid_request', 'by must be company, mcp or account');
    }
    return value as ContextKey;
  },
  fingerprint(url: URL): string | undefined {
    const value = url.searchParams.get('fingerprint');
    if (value === null || value === '') return undefined;
    if (!FINGERPRINT_PATTERN.test(value)) {
      throw new ServiceError('invalid_request', 'fingerprint must be 32 lower-case hex characters');
    }
    return value;
  },
};
