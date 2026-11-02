import type { Queryable } from '@wtfalch/db';
import { withDrizzle } from '@wtfalch/db/drizzle';
import { tables } from '@wtfalch/reporting-core';
import {
  type CreateReportingHandlerOptions,
  createReportingHandler,
  serviceTables,
} from '@wtfalch/reporting-service';
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

function healthHandler(database: Queryable): () => Promise<Response> {
  return async () => {
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
  const { database, ...handlerOptions } = options;
  return {
    handleV1: guardedHandler(
      database,
      createReportingHandler({ ...handlerOptions, redactEnvVars: HOST_SECRET_ENV }),
    ),
    handleHealth: healthHandler(database),
  };
}

interface Store {
  readonly db: CreateReportingHandlerOptions['db'];
  readonly database: Queryable;
}

let store: Store | undefined;

/** Core's tables and the service's, the schema the Drizzle handle is built with. */
const schemaTables = { ...tables, ...serviceTables };

function sharedStore(): Store {
  if (!store) {
    // One pool of 5: the service's Drizzle handle and the plain SQL the
    // health check and the role check run share it.
    const owner = openDatabase('reporting-host', 5);
    store = { db: withDrizzle(owner, { schema: schemaTables }).orm, database: owner.database };
  }
  return store;
}

function buildHost(composition: () => HostComposition): ReportingHost {
  // Composition first: a production host nobody configured refuses before it
  // touches the database.
  const injected = composition();
  return createReportingHost({ ...sharedStore(), ...injected });
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
  return healthHandler(sharedStore().database);
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
