/**
 * The error beacon: `window.onerror` and `unhandledrejection`, plus
 * `captureError()` for an error a React boundary already swallowed (the
 * case `error.tsx` exists for). Batched and posted with `sendBeacon`
 * (falling back to `fetch` with `keepalive`), capped at 5 distinct errors
 * and 20 sends total per page load, so a render loop throwing every frame
 * cannot become a request flood. A repeat past the first occurrence only
 * bumps a counter kept in memory, never resent.
 *
 * No dependencies, no globals beyond `window`.
 *
 * (The page-view/custom-event half of this module moved to
 * `@wtfalch/analytics`'s own beacon -- reporting#71.)
 */

export interface BeaconOptions {
  /** This app's site id, sent with every error batch. */
  readonly site: string;
  /** For tests: the window to observe and the transport to post with. */
  readonly window?: Window;
  readonly send?: (url: string, body: string) => void;
  /** Batch size; the error cap below means this rarely matters. Default 20. */
  readonly batch?: number;
  readonly flushMs?: number;
  /** `window.onerror` + `unhandledrejection`, capped and de-duplicated. Default false. */
  readonly errors?: boolean;
  /** The route `clientErrorHandler` (./next) is mounted at. Required when `errors` is true. */
  readonly errorCollector?: string;
}

export interface Beacon {
  /**
   * Report an error the browser never threw at `window` -- the one a React
   * error boundary caught, which is swallowed before `window.onerror` can
   * see it. Subject to the same de-duplication and the same per-page caps
   * as a thrown one; a no-op when `errors` is off.
   */
  captureError(error: unknown, kind?: string): void;
  destroy(): void;
}

export function createBeacon(options: BeaconOptions): Beacon {
  const win = options.window ?? window;
  const batchSize = Math.min(20, options.batch ?? 20);
  const flushMs = options.flushMs ?? 5000;
  const send =
    options.send ??
    ((url: string, body: string) => {
      const blob = new Blob([body], { type: 'application/json' });
      if (!win.navigator.sendBeacon?.(url, blob)) {
        void win.fetch(url, { method: 'POST', body, keepalive: true, credentials: 'include' });
      }
    });

  // window.onerror + unhandledrejection, capped and de-duplicated. A render
  // loop throwing every frame must not become a request flood: at most 5
  // distinct errors -- by kind + message + first stack line -- and 20 sends
  // total are ever posted per page load; a repeat past the first occurrence
  // only bumps a counter kept in memory, never resent.
  const ERROR_DISTINCT_MAX = 5;
  const ERROR_TOTAL_MAX = 20;
  let errCleanup: (() => void) | null = null;
  let recordError: ((error: unknown, kind?: string) => void) | null = null;
  if (options.errors && options.errorCollector) {
    const errorCollector = options.errorCollector;
    const seen = new Map<string, number>();
    let total = 0;
    const errQueue: { kind: string; message: string; stack: string | null }[] = [];
    let errTimer: ReturnType<typeof setTimeout> | null = null;
    function errFlush(): void {
      if (errTimer) {
        clearTimeout(errTimer);
        errTimer = null;
      }
      if (errQueue.length === 0) return;
      const errors = errQueue.splice(0, batchSize);
      const body = JSON.stringify({ site: options.site, errors });
      try {
        send(errorCollector, body);
      } catch {
        // Same rule as the transport above: never throw into the page.
      }
      if (errQueue.length > 0) errFlush();
    }
    function errPush(entry: { kind: string; message: string; stack: string | null }): void {
      errQueue.push(entry);
      if (errQueue.length >= batchSize) errFlush();
      else if (!errTimer) errTimer = setTimeout(errFlush, flushMs);
    }
    // A query string can carry a token; a stack's frame URLs are the only
    // place one could hide here.
    function stripQuery(text: string): string {
      return text.replace(/\?[^\s:)]*/g, '');
    }
    // The literal first line of `.stack` is just `kind: message` again
    // (V8) or, on Firefox, already a frame; either way the second line is
    // the first real call frame when there is one -- what actually tells
    // two same-kind, same-message errors apart.
    function firstStackLine(stack: string | null): string {
      if (!stack) return '';
      const lines = stack.split('\n');
      return (lines[1] ?? lines[0] ?? '').trim();
    }
    function record(kind: string, message: string, stack: string | null): void {
      const cleanMessage = stripQuery(message);
      const cleanStack = stack === null ? null : stripQuery(stack);
      const key = `${kind}\u0000${cleanMessage}\u0000${firstStackLine(cleanStack)}`;
      const count = seen.get(key);
      if (count !== undefined) {
        seen.set(key, count + 1);
        return; // a repeat: counted, never resent.
      }
      if (seen.size >= ERROR_DISTINCT_MAX || total >= ERROR_TOTAL_MAX) return;
      seen.set(key, 1);
      total += 1;
      errPush({ kind, message: cleanMessage, stack: cleanStack });
    }
    function describeReason(
      reason: unknown,
      fallbackKind: string,
    ): { kind: string; message: string; stack: string | null } {
      if (reason instanceof Error) {
        return {
          kind: reason.name || fallbackKind,
          message: reason.message || fallbackKind,
          stack: typeof reason.stack === 'string' ? reason.stack : null,
        };
      }
      if (typeof reason === 'string') return { kind: fallbackKind, message: reason, stack: null };
      try {
        return {
          kind: fallbackKind,
          message: JSON.stringify(reason) ?? String(reason),
          stack: null,
        };
      } catch {
        return { kind: fallbackKind, message: fallbackKind, stack: null };
      }
    }
    recordError = (error: unknown, kind?: string) => {
      const info = describeReason(error, kind ?? 'Error');
      record(info.kind, info.message, info.stack);
    };
    const onError = (event: ErrorEvent) => {
      // A cross-origin script with no CORS grant reports exactly this
      // message, with no line, column or Error object: nothing here is
      // useful, and every throw from a foreign <script> would otherwise
      // repeat it.
      if (event.message === 'Script error.') return;
      if (event.error instanceof Error || typeof event.error === 'string') {
        const info = describeReason(event.error, 'Error');
        record(info.kind, info.message, info.stack);
      } else {
        record('Error', event.message || 'Error', null);
      }
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const info = describeReason(event.reason, 'UnhandledRejection');
      record(info.kind, info.message, info.stack);
    };
    win.addEventListener('error', onError);
    win.addEventListener('unhandledrejection', onRejection);
    errCleanup = () => {
      errFlush();
      win.removeEventListener('error', onError);
      win.removeEventListener('unhandledrejection', onRejection);
    };
  }

  return {
    captureError: (error, kind) => recordError?.(error, kind),
    destroy() {
      errCleanup?.();
    },
  };
}
