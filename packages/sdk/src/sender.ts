import { DEFAULT_TIMEOUT_MS, errorName } from './transport.js';
import type { DeployColor, ErrorContext, ErrorReport, ErrorRuntime } from './types.js';

/** The backend's limits on one `POST /v1/errors`: 20 reports, 64 KB of body. */
export const SENDER_LIMITS = {
  batch: 20,
  bodyBytes: 64 * 1024,
  /** Characters kept of a message and a stack. The backend redacts and then
   * cuts to 512 and 16,384, keeping 1,024 more before it redacts; cutting at
   * the same place here changes neither what it stores nor the fingerprint. */
  message: 512 + 1024,
  stack: 16384 + 1024,
  kind: 100,
  release: 128,
  requestId: 128,
  /** The backend (reporting#103) takes 1-256 characters and stores only a hash. */
  person: 256,
  /** One context id: 1-128 characters of `CONTEXT_ID_PATTERN`. */
  contextId: 128,
} as const;

/** The same rule the backend applies to `context` values. */
const CONTEXT_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const CONTEXT_KEYS = ['company', 'mcp', 'account'] as const;

export interface ErrorSenderOptions {
  /** The company's reporting backend, `REPORTING_URL`: `https://reporting.<domain>`. */
  url: string;
  /** The app's site key (`ci_rk_...`). Sent as the bearer, never logged. */
  siteKey: string;
  /** Stamped on every report that names none. */
  release?: string;
  /** Stamped on every report that names none. */
  color?: DeployColor;
  /** The runtime a `capture` reports when its context names none. Default `server`. */
  runtime?: ErrorRuntime;
  /** Defaults to the global `fetch`; inject one in tests. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds (default 5000). */
  timeoutMs?: number;
  /** How long a report waits for others to share its request, in milliseconds
   * (default 0: the next turn of the event loop). A full batch goes at once. */
  delayMs?: number;
  /** Reports held while waiting to send, at most (default 100). More are dropped. */
  maxQueue?: number;
  /** Receives fixed text only: never a report's text, never the site key.
   * Defaults to `console.warn`. */
  log?: (message: string) => void;
}

export interface CaptureContext {
  runtime?: ErrorRuntime;
  release?: string;
  color?: DeployColor;
  requestId?: string;
  retryOf?: string;
  context?: ErrorContext;
  /** The signed-in person's issuer id or a session id; never an email or a name. */
  person?: string;
  /** Overrides the class name read from the thrown value. */
  kind?: string;
}

export interface ErrorSender {
  /**
   * Queues one report. The returned promise settles when the request that
   * carries it has finished, failed or timed out, and never rejects, so a
   * Worker can pass it to `ctx.waitUntil()` and a server can ignore it.
   */
  send(report: ErrorReport): Promise<void>;
  /** `send` for a thrown value: its class name, message and stack. Never throws. */
  capture(error: unknown, context?: CaptureContext): Promise<void>;
  /** Sends everything queued now; settles once every request started so far has. Never rejects. */
  flush(): Promise<void>;
}

const RUNTIMES: readonly string[] = ['server', 'edge', 'browser'];

function bounded(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
}

function kindOf(error: unknown): string {
  if (error instanceof Error) return error.constructor?.name || error.name || 'Error';
  if (error === null) return 'null';
  if (error === undefined) return 'undefined';
  if (Array.isArray(error)) return 'array';
  if (typeof error === 'object') {
    const name = (error as { constructor?: { name?: string } }).constructor?.name;
    return name && name !== 'Object' ? name : 'object';
  }
  return typeof error;
}

function messageOf(error: unknown, kind: string): string {
  if (error instanceof Error) return error.message || error.name || kind;
  if (typeof error === 'string') return error || kind;
  try {
    return String(error) || kind;
  } catch {
    return kind;
  }
}

/** Keeps the context ids that pass the backend's rule and drops the rest: a cut id would name another company. */
function contextOf(value: unknown): ErrorContext | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const out: ErrorContext = {};
  for (const key of CONTEXT_KEYS) {
    const id = (value as Record<string, unknown>)[key];
    if (
      typeof id === 'string' &&
      id.length >= 1 &&
      id.length <= SENDER_LIMITS.contextId &&
      CONTEXT_ID_PATTERN.test(id)
    ) {
      out[key] = id;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).byteLength;

/**
 * Sends errors to the company's reporting backend from code with no
 * database: a Cloudflare Worker or a Node server. Global `fetch` only, no
 * Node imports, no dependencies.
 *
 * Reports are batched (at most 20 and 64 KB a request) and each request is
 * bounded by `timeoutMs`. Nothing here throws or rejects: a lost error report
 * is logged as fixed text, not the caller's problem. A failed request is not
 * retried. A `401` means the site key is unknown or revoked: it is logged
 * once, and the sender drops every later report without sending it, since a
 * revoked key stays revoked and a new key comes with a new deploy.
 *
 * The sender redacts nothing: the backend does that, again, on ingest. An
 * app that holds secrets it knows of removes them from a message first.
 */
export function createErrorSender(options: ErrorSenderOptions): ErrorSender {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const delayMs = options.delayMs ?? 0;
  const maxQueue = options.maxQueue ?? 100;
  const endpoint = (() => {
    try {
      return new URL('/v1/errors', options.url).toString();
    } catch {
      return null;
    }
  })();
  const queue: { body: string; done: () => void }[] = [];
  const inFlight = new Set<Promise<void>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let refused = false;
  let dropped = 0;

  function warn(message: string): void {
    try {
      (options.log ?? ((m: string) => console.warn(m)))(message);
    } catch {
      // A broken logger must not turn into a throw in the caller.
    }
  }

  function normalise(report: ErrorReport): ErrorReport | null {
    if (typeof report !== 'object' || report === null) return null;
    const message = bounded(report.message, SENDER_LIMITS.message);
    if (!message || !RUNTIMES.includes(report.runtime)) return null;
    const color = report.color ?? options.color;
    const out: ErrorReport = {
      message,
      runtime: report.runtime,
      occurredAt: bounded(report.occurredAt, 64) ?? new Date().toISOString(),
    };
    const kind = bounded(report.kind?.trim(), SENDER_LIMITS.kind);
    if (kind) out.kind = kind;
    const stack = bounded(report.stack, SENDER_LIMITS.stack);
    if (stack) out.stack = stack;
    const release = bounded(report.release ?? options.release, SENDER_LIMITS.release);
    if (release) out.release = release;
    if (color === 'blue' || color === 'green') out.color = color;
    const requestId = bounded(report.requestId, SENDER_LIMITS.requestId);
    if (requestId) out.requestId = requestId;
    const retryOf = bounded(report.retryOf, SENDER_LIMITS.requestId);
    if (retryOf) out.retryOf = retryOf;
    const context = contextOf(report.context);
    if (context) out.context = context;
    // Dropped, not cut: a cut id would count as a different person.
    const person =
      typeof report.person === 'string' && report.person.length <= SENDER_LIMITS.person
        ? bounded(report.person, SENDER_LIMITS.person)
        : undefined;
    if (person) out.person = person;
    return out;
  }

  async function post(batch: { body: string; done: () => void }[]): Promise<void> {
    const fetcher = options.fetch ?? (typeof fetch === 'undefined' ? undefined : fetch);
    try {
      if (refused) return;
      if (!fetcher || !endpoint) {
        warn('reporting: error reports dropped: no fetch or no valid url');
        return;
      }
      const controller = new AbortController();
      const abort = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.siteKey}`,
            'content-type': 'application/json',
          },
          body: `{"errors":[${batch.map((item) => item.body).join(',')}]}`,
          signal: controller.signal,
        });
        if (response.status === 401) {
          if (!refused)
            warn('reporting: error reports refused: the site key is unknown or revoked');
          refused = true;
        } else if (!response.ok) {
          warn(`reporting: error reports refused: status ${response.status}`);
        }
        await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        warn(
          controller.signal.aborted
            ? 'reporting: error reports dropped: the request timed out'
            : `reporting: error reports dropped: ${errorName(error)}`,
        );
      } finally {
        clearTimeout(abort);
      }
    } catch {
      // Never a throw out of the sender.
    } finally {
      for (const item of batch) item.done();
    }
  }

  /** Takes batches off the queue: at most 20 reports and 64 KB a body. */
  function drain(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    // `{"errors":[` + `]}` and the commas between reports.
    const overhead = bytes('{"errors":[]}');
    while (queue.length > 0) {
      const batch: { body: string; done: () => void }[] = [];
      let size = overhead;
      while (queue.length > 0 && batch.length < SENDER_LIMITS.batch) {
        const next = queue[0] as { body: string; done: () => void };
        const add = bytes(next.body) + (batch.length > 0 ? 1 : 0);
        if (batch.length > 0 && size + add > SENDER_LIMITS.bodyBytes) break;
        batch.push(next);
        queue.shift();
        size += add;
      }
      const request = post(batch).finally(() => {
        inFlight.delete(request);
      });
      inFlight.add(request);
    }
  }

  function send(report: ErrorReport): Promise<void> {
    try {
      if (refused) return Promise.resolve();
      const clean = normalise(report);
      if (!clean) {
        warn('reporting: error report dropped: a message and a runtime are required');
        return Promise.resolve();
      }
      if (queue.length >= maxQueue) {
        dropped++;
        if (dropped === 1 || dropped % 100 === 0) {
          warn(`reporting: error reports dropped: the queue is full (${dropped} so far)`);
        }
        return Promise.resolve();
      }
      const sent = new Promise<void>((resolve) => {
        queue.push({ body: JSON.stringify(clean), done: resolve });
      });
      if (queue.length >= SENDER_LIMITS.batch) drain();
      else if (timer === null) timer = setTimeout(drain, delayMs);
      return sent;
    } catch {
      return Promise.resolve();
    }
  }

  return {
    send,
    capture(error, context = {}) {
      try {
        const kind = bounded(context.kind?.trim(), SENDER_LIMITS.kind) ?? kindOf(error);
        return send({
          kind,
          message: messageOf(error, kind),
          stack:
            error instanceof Error && typeof error.stack === 'string' ? error.stack : undefined,
          runtime: context.runtime ?? options.runtime ?? 'server',
          release: context.release,
          color: context.color,
          requestId: context.requestId,
          retryOf: context.retryOf,
          context: context.context,
          person: context.person,
        });
      } catch {
        return Promise.resolve();
      }
    },
    async flush() {
      try {
        drain();
        await Promise.all([...inFlight]);
      } catch {
        // Never rejects.
      }
    },
  };
}
