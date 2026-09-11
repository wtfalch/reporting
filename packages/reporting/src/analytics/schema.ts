import { z } from 'zod';
import { BANNED_KEYS, SITE_PATTERN } from '../schema.js';

export const ANALYTICS_NAME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/;
export const DEVICES = ['desktop', 'mobile', 'tablet', 'bot', 'unknown'] as const;
export type Device = (typeof DEVICES)[number];

export const ANALYTICS_LIMITS = {
  path: 512,
  referrerHost: 253,
  propsBytes: 4096,
  bodyBytes: 16384,
  batch: 20,
  /** The beacon's clock may disagree with the server's by this much, either way. */
  clockSkewMs: 10 * 60 * 1000,
} as const;

/** The package's own event names; everything else is the host's. */
export const PAGE_VIEW = 'page.view';
export const PAGE_LEAVE = 'page.leave';

const scalar = z.union([z.string().max(1024), z.number(), z.boolean(), z.null()]);

/** Flat, bounded, and never a key that names a person or a secret; the same rule the event log's `data` has, at a quarter of the size. */
export const propsSchema = z.record(z.string().max(64), scalar).superRefine((props, ctx) => {
  for (const key of Object.keys(props)) {
    if ((BANNED_KEYS as readonly string[]).includes(key)) {
      ctx.addIssue({ code: 'custom', path: [key], message: `"${key}" may not be a props key` });
    }
    const value = props[key];
    if (typeof value === 'number' && !Number.isFinite(value)) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'must be a finite number' });
    }
  }
  if (JSON.stringify(props).length > ANALYTICS_LIMITS.propsBytes) {
    ctx.addIssue({
      code: 'custom',
      message: `must serialise to at most ${ANALYTICS_LIMITS.propsBytes} bytes`,
    });
  }
});

const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

/** One event as the beacon sends it. Nothing here names a person: the collector joins identity from the session, never from the body. */
export const beaconEventSchema = z.strictObject({
  name: z.string().regex(ANALYTICS_NAME_PATTERN),
  /** Milliseconds since the epoch, by the browser's clock; clamped on arrival. */
  at: z.number().int().nonnegative(),
  path: z.string().min(1).max(2048),
  referrer: z.string().max(2048).nullish(),
  props: propsSchema.default({}),
  /** Seconds on the page, for `page.leave`. */
  duration: z.number().int().min(0).max(86_400).optional(),
});

export const beaconBatchSchema = z.strictObject({
  site: z.string().regex(SITE_PATTERN),
  visitorId: opaqueId.nullish(),
  sessionId: opaqueId.nullish(),
  events: z.array(beaconEventSchema).min(1).max(ANALYTICS_LIMITS.batch),
});
export type BeaconBatch = z.infer<typeof beaconBatchSchema>;
export type BeaconEvent = z.infer<typeof beaconEventSchema>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
const OPAQUE = /^[A-Za-z0-9_-]{20,}$/;
const HEXISH = /^[0-9a-f]{16,}$/i;

/**
 * The default route normalisation (addendum A7): a pathname with anything
 * that looks like an identifier replaced by a placeholder, so no uuid,
 * numeric id, token or address ever reaches the raw table or a rollup. A
 * host with a route manifest supplies its own and this is the fallback for
 * paths it does not know. The query string and fragment never arrive here;
 * the beacon sends the pathname and the collector strips again anyway.
 */
export function normalisePath(pathname: string): string {
  const raw = pathname.split(/[?#]/)[0] ?? '/';
  const segments = raw.split('/').filter((s) => s.length > 0);
  const out = segments.map((segment) => {
    let s = segment;
    try {
      s = decodeURIComponent(segment);
    } catch {
      return ':x';
    }
    if (UUID.test(s)) return ':id';
    if (NUMERIC.test(s)) return ':n';
    if (s.includes('@') || s.includes('=') || s.includes(':')) return ':x';
    if (HEXISH.test(s) || OPAQUE.test(s) || s.length > 48) return ':x';
    return s.toLowerCase();
  });
  const joined = `/${out.join('/')}`;
  return joined.length > ANALYTICS_LIMITS.path ? joined.slice(0, ANALYTICS_LIMITS.path) : joined;
}

/** The host only: `https://www.example.com/a?b` becomes `www.example.com`; junk becomes null. */
export function referrerHostOf(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  try {
    const host = new URL(referrer).hostname.toLowerCase();
    if (!host || host.length > ANALYTICS_LIMITS.referrerHost) return null;
    return host;
  } catch {
    return null;
  }
}

/** A device class from the user agent, which is then discarded. Coarse on purpose. */
export function deviceOf(userAgent: string | null | undefined): Device {
  if (!userAgent) return 'unknown';
  const ua = userAgent;
  if (
    /bot|crawl|spider|slurp|fetch|headless|lighthouse|preview|monitor|curl|wget|python-requests/i.test(
      ua,
    )
  )
    return 'bot';
  if (/iPad|Tablet|PlayBook|Silk|Kindle/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)))
    return 'tablet';
  if (/Mobi|iPhone|iPod|Android|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return 'mobile';
  return 'desktop';
}

/** Two upper-case letters or nothing; `cf-ipcountry` says `XX` and `T1` for unknown and Tor, which are not countries. */
export function countryOf(header: string | null | undefined): string | null {
  return header && /^[A-Z]{2}$/.test(header) && header !== 'XX' && header !== 'T1' ? header : null;
}

/** The beacon's time, held to within the skew of arrival. */
export function clampOccurredAt(at: number, receivedAt: Date): Date {
  const lo = receivedAt.getTime() - ANALYTICS_LIMITS.clockSkewMs;
  const hi = receivedAt.getTime() + ANALYTICS_LIMITS.clockSkewMs;
  return new Date(Math.min(hi, Math.max(lo, at)));
}
