import type { Db } from '@wtfalch/reporting-core';
import {
  alertRulesBodySchema,
  readAlertRules,
  recordRelease,
  releaseBodySchema,
  saveAlertRules,
} from './alerts.js';
import { writeAudit } from './audit.js';
import { readTextCapped } from './body.js';
import { ServiceError, errorResponse, jsonResponse } from './errors.js';
import { type IngestOptions, ingestErrors } from './ingest.js';
import { type Logger, consoleLogger, errorName } from './log.js';
import { MAX_SERIES_DAYS, errorSeries, getError, listErrors, params, setState } from './reads.js';
import { INGEST_LIMITS, ingestBodySchema, stateBodySchema } from './schema.js';
import {
  type MintedSiteKey,
  type SiteKeyResolver,
  type Tx,
  bindingOf,
  databaseSiteKeys,
  forgetSiteKey,
  mintRequestSchema,
  mintSiteKey,
  operatorKeyMatches,
  revokeSiteKey,
} from './site-keys.js';

export interface CreateReportingHandlerOptions {
  /** The company's database, with core's migrations and this package's applied
   * (`migrationSources`). Must run transactions: a key and its audit row, a
   * state change and its audit row, and a whole ingest batch each commit
   * together. */
  readonly db: Db;
  /** `REPORTING_OPERATOR_KEY`. The operator routes accept this bearer and
   * nothing else; unset or empty, they refuse every caller. */
  readonly operatorKey?: string;
  /** The company's tenant id (`tenantIdOf(AUTH_ORGANIZATION_ID)`), written on
   * every key the operator mints and every row an ingest writes. Unset,
   * minting answers `not_configured`. */
  readonly tenantId?: string;
  /** Which site, environment and tenant each site key writes as. Defaults to
   * `databaseSiteKeys(db)`, which refuses a revoked key. */
  readonly siteKeys?: SiteKeyResolver;
  /** Where a refused request and a failed write are logged, as fixed text and
   * an error name -- never a key, never an error's text. Defaults to one JSON
   * line per entry on stdout/stderr. */
  readonly log?: Logger;
  readonly now?: () => Date;
  /** Extra environment variable names whose values are redacted on ingest. */
  readonly redactEnvVars?: IngestOptions['redactEnvVars'];
  /** Called after an accepted batch, once its rows are committed: the host
   * ticks the error emails from here, after the response. Must not throw. */
  readonly afterIngest?: () => void;
}

const MINT_BODY_BYTES = 4096;
const STATE_BODY_BYTES = 4096;
const RULES_BODY_BYTES = 16 * 1024;
const RELEASE_BODY_BYTES = 4096;
/** A release said to have gone up more than this far ahead of now is refused. */
const RELEASE_FUTURE_MS = 5 * 60_000;
const SITE_KEY_PATH = /^\/v1\/site-keys\/([^/]+)$/;
const ERROR_PATH = /^\/v1\/errors\/([^/]+)$/;
const ERROR_STATE_PATH = /^\/v1\/errors\/([^/]+)\/state$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;

function bearerOf(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

function operatorAuthorised(request: Request, operatorKey: string | undefined): boolean {
  if (!operatorKey) return false;
  return operatorKeyMatches(bearerOf(request), operatorKey);
}

async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const text = await readTextCapped(request, maxBytes);
  if (text === null) throw new ServiceError('invalid_request', 'Body too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new ServiceError('invalid_request', 'Body must be JSON');
  }
}

/**
 * The reporting backend's routes over the Web `Request` (docs/plans/backend.md,
 * "The contract"):
 *
 * - `POST /v1/site-keys`, `DELETE /v1/site-keys/:id` -- operator key.
 * - `POST /v1/errors` -- a site key as the bearer. An unknown or revoked key
 *   is `401` at once: a server caller learns it, and the SDK does not retry.
 * - `GET /v1/errors`, `GET /v1/errors/series`, `GET /v1/errors/:fingerprint`,
 *   `POST /v1/errors/:fingerprint/state` -- operator key.
 * - `GET /v1/alert-rules?site`, `PUT /v1/alert-rules`, `POST /v1/releases` --
 *   operator key: the error emails a company chose, and when a release went
 *   up (alerts.ts).
 *
 * Framework-neutral: a host mounts it at `/v1/*` and passes every request.
 * Anything else is `404`.
 */
export function createReportingHandler(
  options: CreateReportingHandlerOptions,
): (request: Request) => Promise<Response> {
  const { db } = options;
  const log = options.log ?? consoleLogger;
  const now = options.now ?? (() => new Date());
  const tenantId = options.tenantId ?? null;
  const siteKeys = options.siteKeys ?? databaseSiteKeys(db);

  function failed(error: unknown, message: string): Response {
    if (error instanceof ServiceError) return errorResponse(error.code, error.message);
    log.error({ err: errorName(error) }, message);
    return errorResponse('unavailable', 'Service unavailable');
  }

  async function mint(request: Request): Promise<Response> {
    if (!tenantId) throw new ServiceError('not_configured', 'Minting is not configured');
    const parsed = mintRequestSchema.safeParse(await readJson(request, MINT_BODY_BYTES));
    if (!parsed.success) throw new ServiceError('invalid_request', 'Invalid site key request');
    const binding = bindingOf(parsed.data);
    const audit = async (minted: MintedSiteKey, tx: Tx) => {
      await writeAudit(tx, tenantId, {
        operation: 'site_key.mint',
        keyId: minted.id,
        site: minted.site,
      });
      for (const keyId of minted.replaced) {
        await writeAudit(tx, tenantId, { operation: 'site_key.revoke', keyId, site: minted.site });
      }
    };
    // The revoke of the older key, the insert and every audit row commit
    // together, so a failed audit write leaves the older key live.
    const minted = await mintSiteKey(db, { name: parsed.data.name, tenantId, ...binding }, audit);
    for (const keyId of minted.replaced) forgetSiteKey(siteKeys, keyId);
    return jsonResponse(
      {
        id: minted.id,
        secret: minted.secret,
        site: minted.site,
        environment: minted.environment,
      },
      201,
    );
  }

  /** `204` also for an unknown id. The audit row commits with the revoke, and
   * only when the revoke changed a row. */
  async function revoke(keyId: string): Promise<Response> {
    if (KEY_ID.test(keyId)) {
      await db.transaction(async (tx) => {
        const revoked = await revokeSiteKey(tx, keyId);
        if (revoked) {
          await writeAudit(tx, tenantId, {
            operation: 'site_key.revoke',
            keyId,
            site: revoked.site,
          });
        }
      });
      // After the commit, so a lookup in between cannot cache the key again.
      forgetSiteKey(siteKeys, keyId);
    }
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  }

  async function ingest(request: Request): Promise<Response> {
    const secret = bearerOf(request);
    const key = secret ? await siteKeys(secret) : null;
    if (!key) {
      log.info({}, 'reporting: ingest refused: unknown or revoked site key');
      return errorResponse('unauthorized', 'A valid site key is required');
    }
    const parsed = ingestBodySchema.safeParse(await readJson(request, INGEST_LIMITS.bodyBytes));
    if (!parsed.success) {
      log.info({}, 'reporting: ingest refused: invalid batch');
      throw new ServiceError('invalid_request', 'Invalid error batch');
    }
    const accepted = await ingestErrors(
      { db, log, now, redactEnvVars: options.redactEnvVars },
      key,
      parsed.data.errors,
      secret,
    );
    options.afterIngest?.();
    return jsonResponse({ accepted }, 202);
  }

  async function rules(url: URL): Promise<Response> {
    return jsonResponse(await readAlertRules(db, params.site(url)));
  }

  async function putRules(request: Request): Promise<Response> {
    if (!tenantId) throw new ServiceError('not_configured', 'Alert rules are not configured');
    const parsed = alertRulesBodySchema.safeParse(await readJson(request, RULES_BODY_BYTES));
    if (!parsed.success) throw new ServiceError('invalid_request', 'Invalid alert rules');
    return jsonResponse(await saveAlertRules(db, tenantId, parsed.data, now()));
  }

  async function release(request: Request): Promise<Response> {
    const parsed = releaseBodySchema.safeParse(await readJson(request, RELEASE_BODY_BYTES));
    const at = now();
    if (
      !parsed.success ||
      new Date(parsed.data.since).getTime() > at.getTime() + RELEASE_FUTURE_MS
    ) {
      throw new ServiceError('invalid_request', 'Invalid release');
    }
    await recordRelease(db, parsed.data, at);
    return jsonResponse({ ...parsed.data, since: new Date(parsed.data.since).toISOString() });
  }

  async function list(url: URL): Promise<Response> {
    const search = url.searchParams.get('search') ?? undefined;
    const after = url.searchParams.get('after') || undefined;
    return jsonResponse(
      await listErrors(db, {
        site: params.site(url),
        environment: params.environment(url),
        state: params.state(url),
        runtime: params.runtime(url),
        search: search || undefined,
        limit: params.limit(url),
        after,
      }),
    );
  }

  async function series(url: URL): Promise<Response> {
    const site = params.site(url);
    const environment = params.environment(url);
    const from = params.time(url, 'from');
    const to = params.time(url, 'to');
    const bucketMinutes = params.bucket(url);
    const fingerprint = params.fingerprint(url);
    if (to <= from || to.getTime() - from.getTime() > MAX_SERIES_DAYS * 24 * 60 * 60_000) {
      throw new ServiceError('invalid_request', 'to must be after from, at most 31 days later');
    }
    return jsonResponse(
      await errorSeries(db, { site, environment, from, to, bucketMinutes, fingerprint }),
    );
  }

  async function detail(url: URL, fingerprint: string): Promise<Response> {
    const group = await getError(db, params.site(url), fingerprint);
    if (!group) throw new ServiceError('not_found', 'No such error group');
    return jsonResponse(group);
  }

  async function changeState(request: Request, fingerprint: string): Promise<Response> {
    const parsed = stateBodySchema.safeParse(await readJson(request, STATE_BODY_BYTES));
    if (!parsed.success) throw new ServiceError('invalid_request', 'Invalid state request');
    const group = await setState(db, tenantId, { ...parsed.data, fingerprint });
    if (!group) throw new ServiceError('not_found', 'No such error group');
    return jsonResponse(group);
  }

  async function operator(
    request: Request,
    work: () => Promise<Response>,
    message: string,
  ): Promise<Response> {
    if (!operatorAuthorised(request, options.operatorKey)) {
      return errorResponse('unauthorized', 'A valid credential is required');
    }
    try {
      return await work();
    } catch (error) {
      return failed(error, message);
    }
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/v1/errors' && method === 'POST') {
      try {
        return await ingest(request);
      } catch (error) {
        return failed(error, 'reporting: ingest failed');
      }
    }
    if (path === '/v1/site-keys' && method === 'POST') {
      return operator(request, () => mint(request), 'reporting: site key mint failed');
    }
    if (path === '/v1/alert-rules' && method === 'GET') {
      return operator(request, () => rules(url), 'reporting: alert rules read failed');
    }
    if (path === '/v1/alert-rules' && method === 'PUT') {
      return operator(request, () => putRules(request), 'reporting: alert rules save failed');
    }
    if (path === '/v1/releases' && method === 'POST') {
      return operator(request, () => release(request), 'reporting: release record failed');
    }
    const keyId = SITE_KEY_PATH.exec(path)?.[1];
    if (keyId !== undefined && method === 'DELETE') {
      return operator(request, () => revoke(keyId), 'reporting: site key revoke failed');
    }
    if (path === '/v1/errors' && method === 'GET') {
      return operator(request, () => list(url), 'reporting: error list failed');
    }
    if (path === '/v1/errors/series' && method === 'GET') {
      return operator(request, () => series(url), 'reporting: error series failed');
    }
    const stateOf = ERROR_STATE_PATH.exec(path)?.[1];
    if (stateOf !== undefined && method === 'POST') {
      return operator(
        request,
        () => changeState(request, stateOf),
        'reporting: error state change failed',
      );
    }
    const fingerprint = ERROR_PATH.exec(path)?.[1];
    if (fingerprint !== undefined && method === 'GET') {
      return operator(request, () => detail(url, fingerprint), 'reporting: error read failed');
    }
    return errorResponse('not_found', 'Route not found');
  };
}
