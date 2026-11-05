import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Db } from '@wtfalch/reporting-core';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ServiceError } from './errors.js';
import {
  ENVIRONMENTS,
  type ReportingEnvironment,
  SITE_PATTERN,
  type SiteKeyConfig,
} from './schema.js';
import { reportingSiteKeys } from './tables.js';

/** Looks one presented secret up. `null` means unknown or revoked. */
export type SiteKeyResolver = (secret: string) => Promise<SiteKeyConfig | null>;

/** `ci_rk_` and 32 random bytes in base64url (docs/plans/backend.md, "Credentials"). */
export const SITE_KEY_SECRET_PREFIX = 'ci_rk_';

/** Only this hash is stored. The secret is 32 random bytes, so a fast hash is
 * enough: there is nothing to guess. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** A company's tenant id, derived from its sign-in organisation id. One
 * database serves one company, so every key and row in it carries this one
 * value. */
export function tenantIdOf(organisationId: string): string {
  if (organisationId.length === 0) throw new Error('tenantIdOf: an organisation id is required');
  const hex = createHash('sha256').update(`reporting-tenant:${organisationId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Constant time, and independent of either length: both sides are hashed first. */
export function operatorKeyMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** How long a resolved key is remembered, and how many are. A sender would
 * otherwise query the database for every batch, on a pool of a few connections. */
export const SITE_KEY_CACHE_TTL_MS = 60_000;
export const SITE_KEY_CACHE_MAX_ENTRIES = 1000;

export interface SiteKeyCacheOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

/**
 * The host's resolver: a key resolves only while its row exists and is not
 * revoked. A found key is remembered by its hash for `ttlMs` (60 seconds) in
 * at most `maxEntries` entries, oldest out first. A key that is not found is
 * never remembered, so a newly minted key works at once.
 *
 * The handler calls `forget(id)` when this process revokes or replaces a key.
 * Another process that shares the database sees a revoke up to `ttlMs` late.
 */
export function databaseSiteKeys(
  db: Db,
  options: SiteKeyCacheOptions = {},
): SiteKeyResolver & { forget(id: string): void } {
  const ttlMs = options.ttlMs ?? SITE_KEY_CACHE_TTL_MS;
  const maxEntries = options.maxEntries ?? SITE_KEY_CACHE_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { config: SiteKeyConfig; expiresAt: number }>();
  // Counts forgets, so a lookup that began before one does not put its row back.
  let forgets = 0;

  const resolve: SiteKeyResolver = async (secret) => {
    const hash = hashSecret(secret);
    const hit = cache.get(hash);
    if (hit && hit.expiresAt > now()) return hit.config;
    cache.delete(hash);
    const seen = forgets;
    const rows = await db
      .select({
        id: reportingSiteKeys.id,
        site: reportingSiteKeys.site,
        environment: reportingSiteKeys.environment,
        tenantId: reportingSiteKeys.tenantId,
      })
      .from(reportingSiteKeys)
      .where(and(eq(reportingSiteKeys.secretHash, hash), isNull(reportingSiteKeys.revokedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const config: SiteKeyConfig = {
      id: row.id,
      site: row.site,
      environment: row.environment as ReportingEnvironment,
      tenantId: row.tenantId,
    };
    if (forgets === seen && maxEntries > 0) {
      if (cache.size >= maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(hash, { config, expiresAt: now() + ttlMs });
    }
    return config;
  };
  return Object.assign(resolve, {
    forget(id: string): void {
      forgets++;
      for (const [hash, entry] of cache) {
        if (entry.config.id === id) cache.delete(hash);
      }
    },
  });
}

/** Tells a resolver with a cache that this process revoked a key. A plain
 * resolver has nothing to forget. */
export function forgetSiteKey(siteKeys: SiteKeyResolver, id: string): void {
  const forget = (siteKeys as { forget?: unknown }).forget;
  if (typeof forget === 'function') forget.call(siteKeys, id);
}

export const mintRequestSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/),
  site: z.string().regex(SITE_PATTERN).optional(),
  environment: z.enum(ENVIRONMENTS).optional(),
});
export type MintRequest = z.infer<typeof mintRequestSchema>;

export interface SiteKeyBinding {
  readonly site: string;
  readonly environment: ReportingEnvironment;
}

const SITE_MAX_LENGTH = 64;
const SITE_HASH_LENGTH = 8;

/** Makes a name-derived site fit `SITE_PATTERN`: a leading digit gets the
 * prefix `s-`, and a site over 64 characters is cut and ends in a short hash
 * of the whole, so two long names that share a start cannot merge. */
function fitSite(derived: string): string {
  const site = /^[0-9]/.test(derived) ? `s-${derived}` : derived;
  if (site.length <= SITE_MAX_LENGTH) return site;
  const hash = createHash('sha256').update(site).digest('hex').slice(0, SITE_HASH_LENGTH);
  const head = site.slice(0, SITE_MAX_LENGTH - SITE_HASH_LENGTH - 1).replace(/-+$/, '');
  return `${head}-${hash}`;
}

/**
 * What a key writes as, as analytics' `bindingOf`: a body that names `site`
 * or `environment` wins; otherwise a name ending `-stage` or
 * `-stage-reporting` is stage, and the site is the lower-cased name without
 * those suffixes, made to fit `SITE_PATTERN`.
 */
export function bindingOf(request: MintRequest): SiteKeyBinding {
  const base = request.name.toLowerCase().replace(/-reporting$/, '');
  const stage = base.endsWith('-stage');
  const derivedSite = stage ? base.slice(0, -'-stage'.length) : base;
  const site = request.site ?? fitSite(derivedSite);
  if (!SITE_PATTERN.test(site)) {
    throw new ServiceError('invalid_request', 'A site could not be derived from the name');
  }
  return { site, environment: request.environment ?? (stage ? 'stage' : 'production') };
}

export interface MintSiteKeyInput extends SiteKeyBinding {
  readonly name: string;
  readonly tenantId: string;
}

export interface MintedSiteKey extends SiteKeyBinding {
  readonly id: string;
  readonly secret: string;
  /** The ids of the older live keys with the same name that this mint revoked. */
  readonly replaced: readonly string[];
}

/** The transaction handle `Db.transaction` gives its callback. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Taken first inside the mint transaction and released when it ends. One
 * database serves one company and a mint is rare, so one lock for all mints
 * is enough: it serialises two mints of one name (the second revoke sees the
 * first insert) and two mints for different companies (the second
 * foreign-company check sees the first key). */
const MINT_LOCK = sql`select pg_advisory_xact_lock(hashtextextended('reporting_site_keys.mint', 0))`;

/**
 * Stores the hash and returns the secret, once. Minting is idempotent per
 * name, compared without regard to case: foundry retrying after a lost 201
 * leaves one live key, because the mint revokes the name's older live keys
 * in the same transaction. A database that already holds another company's
 * key refuses (`forbidden`): one database serves one company.
 *
 * `within` runs in the same transaction after the insert: whatever it writes
 * (the audit rows) commits with the mint, and a throw rolls the whole mint
 * back, older key included.
 */
export async function mintSiteKey(
  db: Db,
  input: MintSiteKeyInput,
  within?: (minted: MintedSiteKey, tx: Tx) => Promise<void>,
): Promise<MintedSiteKey> {
  const id = randomUUID();
  const secret = `${SITE_KEY_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
  const name = input.name.toLowerCase();
  return db.transaction(async (tx) => {
    await tx.execute(MINT_LOCK);
    const foreign = await tx
      .select({ id: reportingSiteKeys.id })
      .from(reportingSiteKeys)
      .where(ne(reportingSiteKeys.tenantId, input.tenantId))
      .limit(1);
    if (foreign.length > 0) {
      throw new ServiceError('forbidden', 'This database already belongs to another company');
    }
    const revoked = await tx
      .update(reportingSiteKeys)
      .set({ revokedAt: sql`now()` })
      .where(
        and(sql`lower(${reportingSiteKeys.name}) = ${name}`, isNull(reportingSiteKeys.revokedAt)),
      )
      .returning({ id: reportingSiteKeys.id });
    await tx.insert(reportingSiteKeys).values({
      id,
      name,
      secretHash: hashSecret(secret),
      site: input.site,
      environment: input.environment,
      tenantId: input.tenantId,
    });
    const minted: MintedSiteKey = {
      id,
      secret,
      site: input.site,
      environment: input.environment,
      replaced: revoked.map((row) => row.id),
    };
    await within?.(minted, tx);
    return minted;
  });
}

/** Idempotent: an unknown or already revoked id changes nothing. A key keeps
 * the time of its first revocation. Answers whether this call revoked it. */
export async function revokeSiteKey(db: Db | Tx, id: string): Promise<SiteKeyBinding | null> {
  const rows = await db
    .update(reportingSiteKeys)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(reportingSiteKeys.id, id), isNull(reportingSiteKeys.revokedAt)))
    .returning({ site: reportingSiteKeys.site, environment: reportingSiteKeys.environment });
  const row = rows[0];
  return row ? { site: row.site, environment: row.environment as ReportingEnvironment } : null;
}
