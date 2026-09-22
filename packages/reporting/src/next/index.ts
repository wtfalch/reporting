import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { unstable_rethrow } from 'next/navigation';
import { after, connection } from 'next/server';
import { type CollectorOptions, createCollector } from '../analytics/collector.js';
import { countryOf, deviceOf } from '../analytics/schema.js';
import type { Reporting } from '../types.js';
import { type ClientErrorCollectorOptions, createClientErrorCollector } from './client-errors.js';
import { type EdgeErrorIngestOptions, createEdgeErrorIngestCollector } from './edge-errors.js';

export { edgeErrorHandler, type EdgeCaptureOptions, type EdgeErrorReport } from './edge-errors.js';

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

/**
 * The collector as a route handler: mount as `POST` and `OPTIONS` of a public
 * route (`// authz: public`). Always 204. `getUserId` reads the host's
 * session for same-origin beacons; a beacon from an allowed foreign origin
 * never reaches it.
 */
export function collectHandler(
  options: Omit<CollectorOptions, 'log' | 'site'> & { readonly reporting: Reporting },
): (request: Request) => Promise<Response> {
  const { reporting, ...rest } = options;
  const collector = createCollector({ ...rest, log: reporting.log, site: reporting.site });
  return (request) => collector.handle(request);
}

/**
 * `onRequestError` from Next's instrumentation hook
 * (`next/dist/server/instrumentation/types.d.ts`, `InstrumentationOnRequestError`).
 * Declared locally: no public `next` subpath exports the type, and this is
 * the exact shape the compiled server calls it with
 * (`base-server.js`'s `instrumentationOnRequestError`).
 */
export type NextOnRequestError = (
  error: unknown,
  request: Readonly<{
    path: string;
    method: string;
    headers: NodeJS.Dict<string | string[]>;
  }>,
  context: Readonly<{ routerKind: string; routePath: string; routeType: string }>,
) => void | Promise<void>;

function headerValue(dict: NodeJS.Dict<string | string[]>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const key of Object.keys(dict)) {
    if (key.toLowerCase() !== lower) continue;
    const value = dict[key];
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  }
  return null;
}

/**
 * Binds `reporting.captureError` to Next's `onRequestError`
 * (docs/plans/errors.md, "Surface"). `runtime` is `edge` exactly when
 * `NEXT_RUNTIME` says so — the same signal Next's own compiled server
 * branches on (e.g. `dist/server/app-render/action-handler.js`), because
 * the error context Next hands this hook carries no runtime field of its
 * own. `requestId` is derived the same way `requestContext()` derives one:
 * Cloudflare's `cf-ray`, else a fresh uuid.
 *
 * Never throws: Next calls this while already handling an error, and a
 * reporter that throws back is the one failure worse than not reporting —
 * the same rule `captureError` itself already keeps (errors/capture.ts).
 * This catch is defence in depth for a `reporting` that violates it.
 */
export function errorHandler(reporting: Reporting): NextOnRequestError {
  return (error, request) => {
    try {
      const runtime = process.env.NEXT_RUNTIME === 'edge' ? 'edge' : 'server';
      const ray = headerValue(request.headers, 'cf-ray');
      const requestId = ray && RAY_PATTERN.test(ray) ? ray : randomUUID();
      reporting.captureError(error, { runtime, requestId });
    } catch {
      // See the doc comment above: this must never throw back into Next.
    }
  };
}

/**
 * The public ingest route for browser-reported errors: mount as `POST`
 * (docs/plans/errors.md, "Surface"; `// authz: public`). See
 * `createClientErrorCollector` (./client-errors.js) for the caps, the
 * origin allowance and why identity is never the body's.
 */
export function clientErrorHandler(
  options: ClientErrorCollectorOptions,
): (request: Request) => Promise<Response> {
  const collector = createClientErrorCollector(options);
  return (request) => collector.handle(request);
}

/**
 * The node half of `edgeErrorHandler` (./edge-errors.js): mount as `POST` of
 * an internal route (docs/plans/errors.md has no "Surface" entry for this,
 * because it is not a public one -- `// authz: public` would be wrong here;
 * the shared `secret` is the gate). This is where `reporting`'s real `db`
 * lives, so this is where the edge-forwarded report finally becomes a row.
 */
export function edgeErrorIngestHandler(
  options: EdgeErrorIngestOptions,
): (request: Request) => Promise<Response> {
  const collector = createEdgeErrorIngestCollector(options);
  return (request) => collector.handle(request);
}

/** Device and country for a server-side `track`, from the request's headers; nothing else is kept. */
export async function trackContext(): Promise<{
  device: ReturnType<typeof deviceOf>;
  country: string | null;
}> {
  try {
    const h = await headers();
    return { device: deviceOf(h.get('user-agent')), country: countryOf(h.get('cf-ipcountry')) };
  } catch (error) {
    unstable_rethrow(error);
    return { device: 'unknown', country: null };
  }
}
