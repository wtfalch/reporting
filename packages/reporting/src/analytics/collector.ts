import type { Db, Logger } from '../types.js';
import {
  ANALYTICS_LIMITS,
  beaconBatchSchema,
  clampOccurredAt,
  countryOf,
  deviceOf,
  normalisePath,
  referrerHostOf,
} from './schema.js';
import { type AnalyticsRow, insertAnalytics } from './write.js';

/** Which origins may post beacons for which site (D17). The collector's own site is implied by same-origin. */
export type Sites = Readonly<Record<string, { readonly origins: readonly string[] }>>;

export interface CollectorOptions {
  readonly db: Db;
  readonly log: Logger;
  /** The collector's own site: same-origin beacons claiming it are this app's. */
  readonly site: string;
  /** Other sites and the origins allowed to post for them. A same-origin beacon for another site is dropped. */
  readonly sites?: Sites;
  /**
   * The signed-in person, from the host's session, for same-origin beacons
   * only (addendum A5): a beacon from an allowed foreign origin never reads
   * the session, whatever cookies arrive. Return null for nobody.
   */
  readonly getUserId?: (request: Request) => Promise<string | null>;
  /**
   * The organisation a row belongs to, from the resolved person and the
   * pathname as the browser sent it (the query string already gone); attach
   * one only when that person is a member of it. Anonymous or refused claims
   * store null. The normalised route is the third argument, for a host that
   * decides by route rather than by id.
   */
  readonly tenantFor?: (userId: string, pathname: string, route: string) => Promise<string | null>;
  /** The host's route normalisation; the package's default handles what it does not. */
  readonly normalisePath?: (pathname: string) => string;
  readonly identifySignedIn?: () => Promise<boolean>;
  readonly now?: () => Date;
  /** Events per minute per visitor and per client ip. Default 600. */
  readonly ratePerMinute?: number;
}

/** A per-process token bucket, enough to bound abuse, never to meter. */
class Buckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly perMinute: number,
    private readonly now: () => Date,
  ) {}
  take(key: string, n: number): boolean {
    const t = this.now().getTime();
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, at: t };
    b.tokens = Math.min(this.perMinute, b.tokens + ((t - b.at) / 60_000) * this.perMinute);
    b.at = t;
    if (b.tokens < n) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= n;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.buckets.clear();
    return true;
  }
}

const NO_CONTENT = () => new Response(null, { status: 204 });

/**
 * The collector: a public route handler over the Web `Request`. Always 204,
 * so a bad beacon is never a probe; every refusal is a drop and a log line.
 */
export function createCollector(options: CollectorOptions): {
  handle(request: Request): Promise<Response>;
} {
  const now = options.now ?? (() => new Date());
  const buckets = new Buckets(options.ratePerMinute ?? 600, now);
  const normalise = options.normalisePath ?? normalisePath;

  function originFor(request: Request): { kind: 'same' | 'foreign'; origin: string } | null {
    const origin = request.headers.get('origin');
    const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
    if (!origin) return host ? { kind: 'same', origin: `https://${host}` } : null;
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return null;
    }
    return { kind: originHost === host ? 'same' : 'foreign', origin };
  }

  function corsFor(response: Response, origin: string): Response {
    response.headers.set('access-control-allow-origin', origin);
    response.headers.set('vary', 'origin');
    return response;
  }

  async function handle(request: Request): Promise<Response> {
    const where = originFor(request);
    if (request.method === 'OPTIONS') {
      // Preflight for an allowed foreign origin; anything else gets nothing.
      const allowed =
        where?.kind === 'foreign' &&
        Object.values(options.sites ?? {}).some((s) => s.origins.includes(where.origin));
      if (!allowed) return NO_CONTENT();
      const r = corsFor(NO_CONTENT(), where.origin);
      r.headers.set('access-control-allow-methods', 'POST');
      r.headers.set('access-control-allow-headers', 'content-type');
      r.headers.set('access-control-max-age', '600');
      return r;
    }
    if (request.method !== 'POST' || !where) return NO_CONTENT();
    const length = Number(request.headers.get('content-length') ?? '0');
    if (length > ANALYTICS_LIMITS.bodyBytes) return NO_CONTENT();
    let text: string;
    try {
      text = await request.text();
    } catch {
      return NO_CONTENT();
    }
    if (text.length > ANALYTICS_LIMITS.bodyBytes) return NO_CONTENT();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return NO_CONTENT();
    }
    const parsed = beaconBatchSchema.safeParse(json);
    if (!parsed.success) {
      options.log.info({ issues: parsed.error.issues.length }, 'reporting: beacon refused');
      return NO_CONTENT();
    }
    const batch = parsed.data;

    // Which site, and may this origin speak for it.
    let foreign = false;
    if (where.kind === 'same') {
      if (batch.site !== options.site) return NO_CONTENT();
    } else {
      const allowed = options.sites?.[batch.site]?.origins.includes(where.origin) ?? false;
      if (!allowed || batch.site === options.site) return NO_CONTENT();
      foreign = true;
    }

    const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for');
    const n = batch.events.length;
    if (!buckets.take(`ip:${ip ?? 'none'}`, n)) return NO_CONTENT();
    if (batch.visitorId && !buckets.take(`v:${batch.visitorId}`, n)) return NO_CONTENT();

    // Identity is the session's, same-origin only, and never the body's.
    let userId: string | null = null;
    if (!foreign && options.getUserId && ((await options.identifySignedIn?.()) ?? true)) {
      try {
        userId = await options.getUserId(request);
      } catch (error) {
        options.log.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'reporting: getUserId failed; recording anonymously',
        );
      }
    }

    const receivedAt = now();
    const device = deviceOf(request.headers.get('user-agent'));
    const country = countryOf(request.headers.get('cf-ipcountry'));
    const rows: AnalyticsRow[] = [];
    for (const event of batch.events) {
      const pathname = event.path.split(/[?#]/)[0] ?? '/';
      const path = normalise(pathname);
      let tenantId: string | null = null;
      if (userId && options.tenantFor) {
        try {
          tenantId = await options.tenantFor(userId, pathname, path);
        } catch {
          tenantId = null;
        }
      }
      const props: Record<string, string | number | boolean | null> = { ...event.props };
      if (event.duration !== undefined) props.duration = event.duration;
      rows.push({
        occurredAt: clampOccurredAt(event.at, receivedAt),
        receivedAt,
        site: batch.site,
        tenantId,
        visitorId: batch.visitorId ?? null,
        sessionId: batch.sessionId ?? null,
        userId,
        name: event.name,
        path,
        referrerHost: referrerHostOf(event.referrer),
        device,
        country,
        props,
      });
    }
    try {
      await insertAnalytics(options.db, rows);
    } catch (error) {
      options.log.error(
        { err: error instanceof Error ? error.message : String(error), rows: rows.length },
        'reporting: analytics insert failed',
      );
    }
    const response = NO_CONTENT();
    return foreign ? corsFor(response, where.origin) : response;
  }

  return { handle };
}
