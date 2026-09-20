import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ANALYTICS_LIMITS } from '../analytics/schema.js';
import { Buckets } from '../ingest-limit.js';
import { SITE_PATTERN } from '../schema.js';
import type { Reporting } from '../types.js';

/**
 * The public ingest route for browser-reported errors
 * (docs/plans/errors.md, "Surface"): modelled exactly on the analytics
 * collector (`../analytics/collector.js`) — always 204, the same origin
 * allowance, the same body-size cap — because that ingest problem is
 * already solved there and a second set of limits would be a second set to
 * get wrong.
 *
 * Two things differ from the analytics collector, both because a
 * `Reporting` instance is already bound to one site:
 * 1. There is no `sites` map to route a foreign origin's claim to a
 *    different site's table — `origins` below is a flat allow-list, and a
 *    batch claiming any other site is dropped, same-origin or not.
 * 2. A capture goes through `reporting.captureError`, not a direct insert,
 *    so there is no `now`/`db` to take here: capture.ts already has its own.
 */

export interface ClientErrorCollectorOptions {
  readonly reporting: Reporting;
  /** Foreign origins allowed to post errors for this site, beside same-origin. */
  readonly origins?: readonly string[];
  /**
   * The signed-in person, from the host's session, for a same-origin
   * request only — a foreign origin never reads it (addendum A5's rule,
   * same as the analytics collector's `getUserId`).
   */
  readonly getUserId?: (request: Request) => Promise<string | null>;
  /**
   * The host's tenant lookup for that person. Unlike the analytics
   * collector's `tenantFor`, there is no pathname to hand over: an error
   * batch names no single route the way a page view does.
   */
  readonly tenantFor?: (userId: string) => Promise<string | null>;
  /**
   * Captures allowed per minute per client address. An unauthenticated route
   * that writes rows needs a ceiling that does not depend on the caller being
   * our own beacon: the browser's 5-distinct/20-total cap is one line of
   * client code away from being ignored, and `reporting_errors` never prunes
   * an open row. Lower than the analytics default because an error is rarer
   * than a page view by design; a client hitting this is already broken.
   */
  readonly ratePerMinute?: number;
}

/** At most this many entries of a batch are ever captured; the rest are dropped silently. */
const BATCH_MAX = 10;

/**
 * Not `z.strictObject`, unlike the analytics beacon schema: a client that
 * adds `tenantId`, `userId` or `requestId` here must have that field
 * silently stripped, not the whole batch refused. `handle()` below never
 * reads such a field either way — identity and the request id come only
 * from this request itself (`getUserId`/`tenantFor`, and `cf-ray`/a fresh
 * uuid), never from the body. The browser is not a trusted caller.
 */
const entrySchema = z.object({
  kind: z.string().min(1),
  message: z.string().min(1),
  stack: z.string().nullish(),
  release: z.string().nullish(),
});

const batchSchema = z.object({
  site: z.string().regex(SITE_PATTERN),
  errors: z.array(entrySchema).min(1),
});

const NO_CONTENT = () => new Response(null, { status: 204 });

/**
 * The client's address as the tunnel presents it. `cf-connecting-ip` first
 * because every request to this estate arrives through Cloudflare, then the
 * first hop of `x-forwarded-for`; a header a client sets itself is no worse
 * here than no key at all, since the bucket only ever costs that same client.
 */
function clientAddress(request: Request): string | null {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const xff = request.headers.get('x-forwarded-for');
  return xff ? (xff.split(',')[0] ?? '').trim() || null : null;
}

/** `<16 hex>-<colo>`, as Cloudflare emits it — the same pattern `./index.ts` uses; kept here too, rather than imported, to avoid a circular import between the two files. */
const RAY_PATTERN = /^[0-9a-f]{16}-[A-Z0-9]{3,6}$/;

function requestIdOf(request: Request): string {
  const ray = request.headers.get('cf-ray');
  return ray && RAY_PATTERN.test(ray) ? ray : randomUUID();
}

/**
 * Same shape as the collector's own `originFor` (`../analytics/collector.js`,
 * private there): duplicated rather than exported, per this task's scope —
 * it is ~10 lines and the two callers now diverge (no `sites` map here).
 */
function originOf(request: Request): { kind: 'same' | 'foreign'; origin: string } | null {
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

/**
 * An `Error` carrying exactly the client's own message and stack, so
 * `captureError`'s existing redaction and fingerprinting run unchanged on
 * it (errors/capture.ts is not this task's to edit). The class name is
 * never read from this: `context.kind` below overrides it with the
 * client's own `kind`.
 */
function toCapturable(entry: { message: string; stack?: string | null }): Error {
  const err = new Error(entry.message);
  err.stack = entry.stack ?? undefined;
  return err;
}

export function createClientErrorCollector(options: ClientErrorCollectorOptions): {
  handle(request: Request): Promise<Response>;
} {
  const { reporting } = options;
  const buckets = new Buckets(options.ratePerMinute ?? 60, () => new Date());

  async function handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') return NO_CONTENT();
    const where = originOf(request);
    if (!where) return NO_CONTENT();
    if (where.kind === 'foreign' && !(options.origins ?? []).includes(where.origin)) {
      return NO_CONTENT();
    }
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
    const parsed = batchSchema.safeParse(json);
    if (!parsed.success) {
      reporting.log.info(
        { issues: parsed.error.issues.length },
        'reporting: client error batch refused',
      );
      return NO_CONTENT();
    }
    if (parsed.data.site !== reporting.site) return NO_CONTENT();

    // After parsing, so the cost of a refused body is not charged to the
    // address, and before any capture, so the bucket bounds what is written
    // rather than what was asked. Keyed on the address alone: a visitor id
    // would be the client's own claim, and this is the route that exists
    // because the client is not trusted.
    const entries = parsed.data.errors.slice(0, BATCH_MAX);
    if (!buckets.take(`ip:${clientAddress(request) ?? 'none'}`, entries.length)) {
      return NO_CONTENT();
    }

    // Identity is the session's, same-origin only, and never the body's
    // (the entry schema above has no tenantId/userId field to begin with).
    let userId: string | null = null;
    if (where.kind === 'same' && options.getUserId) {
      try {
        userId = await options.getUserId(request);
      } catch (error) {
        reporting.log.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'reporting: client error getUserId failed; capturing without a tenant',
        );
      }
    }
    let tenantId: string | null = null;
    if (userId && options.tenantFor) {
      try {
        tenantId = await options.tenantFor(userId);
      } catch {
        tenantId = null;
      }
    }

    // This request's own id, cf-ray or a fresh uuid — never the body's;
    // same rule `errorHandler` (./index.ts) follows for a server capture.
    const requestId = requestIdOf(request);

    for (const entry of entries) {
      reporting.captureError(toCapturable(entry), {
        kind: entry.kind,
        runtime: 'browser',
        release: entry.release ?? null,
        tenantId,
        requestId,
      });
    }

    const response = NO_CONTENT();
    return where.kind === 'foreign' ? corsFor(response, where.origin) : response;
  }

  return { handle };
}
