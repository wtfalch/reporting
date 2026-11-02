import type { Queryable } from '@wtfalch/db';
import { withDrizzle } from '@wtfalch/db/drizzle';
import { createReporting, tables } from '@wtfalch/reporting-core';
import {
  type Housekeeping,
  createHousekeeping,
  pruneErrors,
  pruneEvents,
  pruneOpenErrors,
  retentionLag,
} from '@wtfalch/reporting-core/housekeeping';
import {
  type CreateReportingHandlerOptions,
  createReportingHandler,
  serviceTables,
} from '@wtfalch/reporting-service';
import { eq } from 'drizzle-orm';
import { after } from 'next/server';
import {
  type HostComposition,
  assertDevelopmentEnv,
  developmentComposition,
  isDevelopmentEnv,
  productionComposition,
} from './composition';
import { openDatabase } from './connection';
import { checkRuntimeRoleOnce, guardedHandler } from './runtime-role-guard';

export interface ReportingHost {
  /** Routes `/v1/*` through the service package's handler, behind the runtime
   * role check (`runtime-role-guard.ts`'s `guardedHandler`). */
  readonly handleV1: (request: Request) => Promise<Response>;
  /** Answers `/api/health` with the estate's health contract: `{ ok, service,
   * version, checks }`. `checks` names each dependency this host has -- today
   * just `database` -- and that one check both confirms the connected role is
   * a safe runtime role (`checkRuntimeRoleOnce`, cached for the process per
   * analytics ADR 0014) and runs a real, short-timeout query, fresh on every
   * call. Unlike the role verdict, the query is never cached: a database that
   * died after the first healthy call must 503 on the next one, not keep
   * reporting the first call's pass. */
  readonly handleHealth: () => Promise<Response>;
}

/** What the composition root needs: the Drizzle handle the service runs on,
 * the plain SQL handle over the same pool (the role check and the health
 * query), and the service's own options. */
export interface ReportingHostOptions
  extends Omit<CreateReportingHandlerOptions, 'db' | 'redactEnvVars'> {
  readonly db: CreateReportingHandlerOptions['db'];
  readonly database: Queryable;
  /** Ticked after each `/api/health` answer. Unset in tests that do not need it. */
  readonly housekeeping?: HealthTicker;
}

/** Reported under `checks[].name` for this host's one dependency. */
const DATABASE_CHECK = 'database';

/** Keeps a stuck dependency from holding the route open: the Dockerfile's
 * `HEALTHCHECK` gives curl 5s, so this must lose the race well before that. */
const HEALTH_QUERY_TIMEOUT_MS = 3_000;

/** The host's own secrets, redacted from every stored report on top of the
 * service's own (the operator key and KEYSTORE_*): the runtime connection
 * string carries a password. `DATABASE_URL_OWNER` never reaches the server
 * (start.sh), so it has no value here to redact. */
const HOST_SECRET_ENV = ['DATABASE_URL'];

/** Reported as `site` on the host's own events and housekeeping rows. */
const HOST_SITE = 'reporting-host';

/** Event retention the host starts with (D3). Core's own default is 30. */
const HOST_RETENTION_DAYS = 90;
const RETENTION_KEY = 'events.retention_days';

type HostDb = CreateReportingHandlerOptions['db'];

/** What the health route needs from housekeeping: the tick. */
export interface HealthTicker {
  tick(): Promise<void>;
}

export interface HealthCheck {
  readonly name: string;
  readonly ok: boolean;
}

/**
 * Races `run()` against `timeoutMs`. There is no query-level cancellation
 * here, so a timed-out query keeps running after this stops waiting for it;
 * `attempt.catch(() => undefined)` marks it handled up front so a rejection
 * that arrives after the deadline already won never surfaces as an
 * unhandled promise rejection. The `finally` clears the timer either way.
 */
function withDeadline<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = run();
  attempt.catch(() => undefined);
  return Promise.race([
    attempt,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('health check timed out')), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * The one check this host has. Never returns the error that failed it: a 503
 * body says which dependency is down, not why, so nothing from a database
 * driver's error text (a connection string, a query) ever reaches an
 * unauthenticated caller of this public route.
 */
async function checkDatabase(database: Queryable): Promise<HealthCheck> {
  try {
    await checkRuntimeRoleOnce(database);
    await withDeadline(() => database.query('select 1'), HEALTH_QUERY_TIMEOUT_MS);
    return { name: DATABASE_CHECK, ok: true };
  } catch {
    return { name: DATABASE_CHECK, ok: false };
  }
}

/** A manually-flipped flag (`MAINTENANCE=true`), read fresh on every call.
 * Reported in the body so a prober can show "maintenance" rather than "up",
 * while the route still answers 200 so a boolean health check (Coolify's own)
 * does not restart-loop a host that is down on purpose. */
function isMaintenance(): boolean {
  return process.env.MAINTENANCE === 'true';
}

function healthHandler(database: Queryable, housekeeping?: HealthTicker): () => Promise<Response> {
  return async () => {
    if (housekeeping) {
      // After the response, so a slow prune never holds the health check. The
      // tick does not throw; the catch is for a ticker that breaks that rule.
      after(async () => {
        try {
          await housekeeping.tick();
        } catch {
          console.warn('reporting-host: housekeeping tick failed');
        }
      });
    }
    const checks = [await checkDatabase(database)];
    const healthy = checks.every((check) => check.ok);
    const maintenance = isMaintenance();
    return Response.json(
      {
        ok: healthy,
        service: 'reporting-host',
        version: process.env.APP_VERSION ?? 'unknown',
        checks,
        ...(maintenance ? { maintenance: true } : {}),
      },
      {
        status: healthy || maintenance ? 200 : 503,
        headers: { 'cache-control': 'no-store' },
      },
    );
  };
}

/**
 * The composition root: the only place that knows how a database, an
 * operator key and a tenant become a running reporting host. Takes them as
 * plain arguments, so a test can inject fakes without a real database, env
 * var or network call.
 */
export function createReportingHost(options: ReportingHostOptions): ReportingHost {
  const { database, housekeeping, ...handlerOptions } = options;
  return {
    handleV1: guardedHandler(
      database,
      createReportingHandler({ ...handlerOptions, redactEnvVars: HOST_SECRET_ENV }),
    ),
    handleHealth: healthHandler(database, housekeeping),
  };
}

interface Store {
  readonly db: HostDb;
  readonly database: Queryable;
  readonly housekeeping: Housekeeping;
}

const hostLog = {
  info: () => undefined,
  warn: () => console.warn('reporting-host: reporting warning'),
  error: () => console.error('reporting-host: reporting error'),
};

/**
 * Housekeeping for the host: the four prunes, with event retention set to 90
 * days once. A row already in `reporting_settings` is never overwritten, so an
 * operator's later change stands. The seed runs before the first tick and is
 * retried on the next tick when it fails; the tick itself never throws.
 */
export function createHostHousekeeping(db: HostDb): Housekeeping {
  const reporting = createReporting({ db, log: hostLog, site: HOST_SITE });
  const core = createHousekeeping({ reporting, db });
  for (const task of [pruneEvents, retentionLag, pruneErrors, pruneOpenErrors]) {
    core.register(task);
  }
  let seeded: Promise<void> | undefined;
  async function seedRetention(): Promise<void> {
    const rows = await db
      .select({ key: tables.settings.key })
      .from(tables.settings)
      .where(eq(tables.settings.key, RETENTION_KEY));
    if (rows.length > 0) return;
    await reporting.settings.set(
      { [RETENTION_KEY]: HOST_RETENTION_DAYS },
      { class: 'service', id: HOST_SITE },
    );
  }
  return {
    ...core,
    async tick() {
      try {
        seeded ??= seedRetention();
        await seeded;
      } catch {
        seeded = undefined;
        console.warn('reporting-host: retention seed failed');
        return;
      }
      await core.tick();
    },
  };
}

let store: Store | undefined;

/** Core's tables and the service's, the schema the Drizzle handle is built with. */
const schemaTables = { ...tables, ...serviceTables };

function sharedStore(): Store {
  if (!store) {
    // One pool of 5: the service's Drizzle handle and the plain SQL the
    // health check and the role check run share it.
    const owner = openDatabase('reporting-host', 5);
    const db = withDrizzle(owner, { schema: schemaTables }).orm;
    store = { db, database: owner.database, housekeeping: createHostHousekeeping(db) };
  }
  return store;
}

function buildHost(composition: () => HostComposition): ReportingHost {
  // Composition first: a production host nobody configured refuses before it
  // touches the database.
  const injected = composition();
  const { db, database, housekeeping } = sharedStore();
  return createReportingHost({ db, database, housekeeping, ...injected });
}

/**
 * Explicit development host: the fixed operator key, tenant and site key.
 * Throws unless NODE_ENV is 'development' or 'test'.
 */
export function developmentHost(): ReportingHost {
  assertDevelopmentEnv('developmentHost()');
  return buildHost(developmentComposition);
}

/**
 * Answers /api/health. Needs the store only, never the composition, so a
 * production host still reports health before instrumentation has run.
 */
export function sharedHealth(): () => Promise<Response> {
  const { database, housekeeping } = sharedStore();
  return healthHandler(database, housekeeping);
}

let instance: ReportingHost | undefined;

/**
 * The module-level instance the routes call, built lazily on first use and
 * never at import time. A module-level `createDatabase(...)` call here would
 * make `next build` open a database connection during the build, which fails
 * where there is no database at all -- reporting-host.test.ts asserts this by
 * importing the module with `DATABASE_URL` unset.
 *
 * NODE_ENV exactly 'development' or 'test' uses the development composition.
 * Anything else, including an unset or misspelled NODE_ENV, is production: it
 * throws unless instrumentation.ts injected the production composition.
 */
export function sharedHost(): ReportingHost {
  if (!instance) {
    instance = buildHost(isDevelopmentEnv() ? developmentComposition : productionComposition);
  }
  return instance;
}
