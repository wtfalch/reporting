import type { CreateReportingHandlerOptions, SiteKeyResolver } from '@wtfalch/reporting-service';

/**
 * What the host hands the service's handler beyond the database: the operator
 * key, the company's tenant id and, in development or a test only, a fixed
 * site key. Left out, `siteKeys` is the database's own `reporting_site_keys`,
 * which is what a deployed backend wants.
 *
 * The reporting service has no access resolver: every read is the operator
 * key's (Boule reads with it and audits who looked, docs/plans/backend.md), and
 * the ingest trusts only a site key. So where analytics' composition fails
 * closed on a missing resolver, this one fails closed on a missing injection:
 * production serves nothing until `instrumentation.ts` has run.
 */
export type HostComposition = Partial<
  Pick<CreateReportingHandlerOptions, 'operatorKey' | 'tenantId' | 'siteKeys'>
>;

/**
 * Development composition is allowed only when NODE_ENV is exactly
 * 'development' or 'test'. An unset or misspelled NODE_ENV is production.
 */
export function isDevelopmentEnv(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
}

export function assertDevelopmentEnv(what: string): void {
  if (!isDevelopmentEnv()) {
    throw new Error(
      `${what} is development-only: NODE_ENV must be 'development' or 'test' (got ${JSON.stringify(process.env.NODE_ENV)}).`,
    );
  }
}

/** DEVELOPMENT ONLY -- a fixed operator key, so a local reader has something
 * to send. foundry generates the real one per company. */
export const DEVELOPMENT_OPERATOR_KEY = 'dev-operator-key';

/** DEVELOPMENT ONLY -- the tenant every development row carries. */
export const DEVELOPMENT_TENANT_ID = '00000000-0000-4000-8000-000000000000';

/**
 * DEVELOPMENT ONLY -- one fixed site key, so a local sender has something to
 * post against. Minting and rotating a real one, per app and environment, is
 * foundry's job (docs/plans/backend.md, slice 5), not this host's.
 */
export const DEVELOPMENT_SITE_KEY = 'dev-site-key';
export const developmentSiteKeys: SiteKeyResolver = async (secret) =>
  secret === DEVELOPMENT_SITE_KEY
    ? {
        id: DEVELOPMENT_SITE_KEY,
        site: 'app',
        environment: 'production',
        tenantId: DEVELOPMENT_TENANT_ID,
      }
    : null;

/** Explicit development composition: the fixed operator key, tenant and site key. */
export function developmentComposition(): HostComposition {
  assertDevelopmentEnv('developmentComposition()');
  return {
    operatorKey: DEVELOPMENT_OPERATOR_KEY,
    tenantId: DEVELOPMENT_TENANT_ID,
    siteKeys: developmentSiteKeys,
  };
}

// On globalThis under a Symbol key: Next bundles instrumentation.ts and each
// route separately, so a module-level variable would not be shared.
const INJECTED = Symbol.for('wtfalch.reporting.productionComposition');
type Slot = { [INJECTED]?: HostComposition };

/**
 * Production calls this once at startup (apps/host/src/instrumentation.ts)
 * with the operator key and the company's tenant id, each possibly unset:
 * the service refuses every operator call without a key, and answers a mint
 * `not_configured` without a tenant. It rejects the development operator key
 * and the development site key, by value and by identity.
 */
export function configureProductionComposition(composition: HostComposition): void {
  if (composition.operatorKey === DEVELOPMENT_OPERATOR_KEY) {
    throw new Error('configureProductionComposition: the development operator key is not allowed.');
  }
  if (composition.siteKeys === developmentSiteKeys) {
    throw new Error('configureProductionComposition: the development site key is not allowed.');
  }
  (globalThis as Slot)[INJECTED] = composition;
}

/** Production composition. Fails closed: never falls back to the development one. */
export function productionComposition(): HostComposition {
  const injected = (globalThis as Slot)[INJECTED];
  if (!injected) {
    throw new Error(
      'Production requires an injected composition: call configureProductionComposition({ operatorKey, tenantId }) from src/instrumentation.ts. The development operator key and site key are never used outside NODE_ENV=development or test.',
    );
  }
  return injected;
}

/** Test-only: forget an injected production composition. */
export function resetProductionComposition(): void {
  (globalThis as Slot)[INJECTED] = undefined;
}
