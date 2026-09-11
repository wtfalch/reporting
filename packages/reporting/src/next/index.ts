import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { unstable_rethrow } from 'next/navigation';
import { after, connection } from 'next/server';
import type { Reporting } from '../types.js';

/**
 * The Next bindings: everything in the package that knows what a request is.
 * Peer on `next`; a host without Next never imports this entry.
 */

/**
 * The health route, and the heartbeat behind it. `connection()` first,
 * because under `cacheComponents` a route with no dynamic read is
 * prerendered, and the tick would otherwise run at build time with no
 * database. The tick runs after the response and never throws.
 */
export function healthHandler(housekeeping: { tick(): Promise<void> }): () => Promise<Response> {
  return async () => {
    await connection();
    after(() => housekeeping.tick());
    return Response.json({ ok: true, ts: new Date().toISOString() });
  };
}

/** `<16 hex>-<colo>`, as Cloudflare emits it. */
const RAY_PATTERN = /^[0-9a-f]{16}-[A-Z0-9]{3,6}$/;

export interface RequestContext {
  /** Cloudflare's `cf-ray` when the request came through the tunnel, else a uuid. */
  readonly id: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** Two letters from `cf-ipcountry`, or null. */
  readonly country: string | null;
}

/**
 * Read once where a request enters (a Server Action, a route handler, a
 * page's data component) and handed down. Outside a request scope it returns
 * a fresh id and nulls, but only after `unstable_rethrow`: under
 * `cacheComponents`, `headers()` in a prerender throws the signal Next uses
 * to bail out, and swallowing that would poison the render.
 */
export async function requestContext(): Promise<RequestContext> {
  try {
    const h = await headers();
    const country = h.get('cf-ipcountry');
    // A ray id is Cloudflare's or it is nothing: a request that reached the
    // origin some other way (the Docker network, a preview host) could
    // otherwise choose the id stamped on the audit rows of this request.
    const ray = h.get('cf-ray');
    return {
      id: ray && RAY_PATTERN.test(ray) ? ray : randomUUID(),
      ip: h.get('cf-connecting-ip'),
      userAgent: h.get('user-agent'),
      country: country && /^[A-Z]{2}$/.test(country) ? country : null,
    };
  } catch (error) {
    unstable_rethrow(error);
    return { id: randomUUID(), ip: null, userAgent: null, country: null };
  }
}

/** `after()` inside a request; a timer outside one (boot, a script), so a row queued there still flushes. */
export const deferWithAfter = (fn: () => Promise<void>): void => {
  try {
    after(fn);
  } catch {
    setTimeout(() => void fn(), 0);
  }
};

let shutdownRegistered = false;

/**
 * One best-effort drain on SIGTERM, bounded so a rolling deploy's drain
 * window is respected. Not a durable queue: a forced kill or a slow database
 * loses what is queued, and the logger already has every row.
 */
export function registerShutdownFlush(
  reporting: Reporting,
  opts: { deadlineMs?: number } = {},
): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  process.once('SIGTERM', () => {
    void reporting.flush({ deadlineMs: opts.deadlineMs ?? 2000 });
  });
}
