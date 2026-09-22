import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Reporting } from '../types.js';
import type { NextOnRequestError } from './index.js';

/**
 * The edge runtime has no database connection (docs/plans/errors.md never
 * covered it; `errorHandler`/`captureError` assume one). `errorHandler`
 * (./index.js) still gets called there -- `NEXT_RUNTIME` says `edge` -- but
 * a `Reporting` built over a driver that needs a TCP socket cannot even be
 * constructed in that runtime, so the capture it tries to defer never runs.
 *
 * The fix is not to teach the edge runtime to write Postgres. It is to keep
 * capture edge-safe: serialise the error and hand it to a node route
 * handler over `fetch`, the one thing both runtimes share, and let that
 * route -- which does have a `db` -- call `captureError` for real.
 * `edgeErrorHandler` is the edge half; `createEdgeErrorIngestCollector`
 * (wrapped as `edgeErrorIngestHandler` in ./index.js) is the node half.
 *
 * The shared `secret` is what stops a stranger from writing rows into
 * `reporting_errors` through this route: unlike `clientErrorHandler`, whose
 * public ingest is meant for any browser to call, this one exists only for
 * this app's own edge runtime to call, and has no session or origin to
 * check instead.
 */

const RAY_PATTERN = /^[0-9a-f]{16}-[A-Z0-9]{3,6}$/;

function headerValue(dict: NodeJS.Dict<string | string[]>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const key of Object.keys(dict)) {
    if (key.toLowerCase() !== lower) continue;
    const value = dict[key];
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  }
  return null;
}

export interface EdgeErrorReport {
  readonly kind: string;
  readonly message: string;
  readonly stack: string | null;
  readonly release: string | null;
  readonly requestId: string;
}

export interface EdgeCaptureOptions {
  /** Where `edgeErrorIngestHandler` (./index.js) is mounted; same-origin path or an absolute URL. */
  readonly endpoint: string;
  /** Must match `EdgeErrorIngestOptions.secret` on the receiving end. */
  readonly secret: string;
  readonly release?: string | null;
  /** Bounds how long a slow or hung node route can hold this up. Default 2000ms. */
  readonly timeoutMs?: number;
  /** For tests: replaces the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/**
 * Binds to Next's `onRequestError` for the edge runtime. Builds the report
 * from the error alone -- no `db`, no `Reporting` instance needed -- and
 * POSTs it to the node route.
 *
 * Awaited, not fire-and-forget: `NextOnRequestError` may return a promise
 * exactly so a hook like this can be waited on, and an edge isolate is free
 * to be torn down the instant this function returns -- a POST left running
 * behind an unawaited call is a coin flip on whether it ever leaves the
 * process. `timeoutMs` bounds the wait so a hung node route cannot hold
 * Next's own error handling open indefinitely. Never throws back into Next,
 * the same rule `errorHandler` (./index.js) already keeps.
 */
export function edgeErrorHandler(options: EdgeCaptureOptions): NextOnRequestError {
  const doFetch = options.fetch ?? fetch;
  return async (error, request) => {
    try {
      const ray = headerValue(request.headers, 'cf-ray');
      const requestId = ray && RAY_PATTERN.test(ray) ? ray : randomUUID();
      const body: EdgeErrorReport = {
        kind: error instanceof Error ? error.name || 'Error' : 'Error',
        message:
          error instanceof Error
            ? error.message || error.name || 'Error'
            : typeof error === 'string'
              ? error
              : 'unknown edge error',
        stack: error instanceof Error && typeof error.stack === 'string' ? error.stack : null,
        release: options.release ?? null,
        requestId,
      };
      await doFetch(options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-reporting-edge-secret': options.secret,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 2000),
      });
    } catch {
      // Never throw back into Next: see errorHandler's own doc comment. A
      // failed or timed-out forward just means this occurrence is lost.
    }
  };
}

const reportSchema = z.object({
  kind: z.string().min(1),
  message: z.string().min(1),
  stack: z.string().nullish(),
  release: z.string().nullish(),
  requestId: z.string().min(1),
});

export interface EdgeErrorIngestOptions {
  readonly reporting: Reporting;
  /** Must match `EdgeCaptureOptions.secret` on the sending end. */
  readonly secret: string;
}

const NO_CONTENT = () => new Response(null, { status: 204 });

/** Constant-time so a network trace of response latency cannot narrow the secret. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The node half of the pair: not a public ingest like `clientErrorHandler`'s
 * (no origin allowance, no rate limiter, no batching) because it is not
 * meant to be reachable except by this app's own edge runtime holding the
 * shared secret. A request missing or failing that check is dropped the
 * same silent way every ingest route in this package answers a bad one --
 * always 204, so a prober learns nothing.
 */
export function createEdgeErrorIngestCollector(options: EdgeErrorIngestOptions): {
  handle(request: Request): Promise<Response>;
} {
  async function handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') return NO_CONTENT();
    const provided = request.headers.get('x-reporting-edge-secret');
    if (!provided || !secretMatches(provided, options.secret)) return NO_CONTENT();
    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return NO_CONTENT();
    }
    const parsed = reportSchema.safeParse(json);
    if (!parsed.success) return NO_CONTENT();
    const { kind, message, stack, release, requestId } = parsed.data;
    const err = new Error(message);
    err.stack = stack ?? undefined;
    options.reporting.captureError(err, {
      kind,
      runtime: 'edge',
      release: release ?? null,
      requestId,
    });
    return NO_CONTENT();
  }
  return { handle };
}
