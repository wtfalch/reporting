/**
 * The beacon: `page.view` on load and on history changes, `page.leave` with
 * the seconds on the page, and whatever the host `track`s, batched twenty at
 * a time or every five seconds and posted with `sendBeacon` (falling back to
 * `fetch` with `keepalive`). It sends the pathname, never the query string,
 * and never a user id: the collector knows who is signed in from the session
 * cookie, and a client-supplied id would be a claim (D14).
 *
 * Consent (D15): `none` keeps nothing; `consented` starts as `none` until
 * `accept()`; `always` sets the first-party cookie without asking. The cookie
 * `_rp` holds the visitor id and the answer, one year, SameSite=Lax, Secure;
 * the session id lives in `sessionStorage` under `consented`/`always` and in
 * memory under `none`. Nothing about the browser is stored beyond that.
 *
 * No dependencies, no globals beyond `window`; under 3 KB gzipped.
 */

export type ConsentMode = 'none' | 'consented' | 'always';
export type ConsentAnswer = 'accepted' | 'declined' | null;

export interface BeaconOptions {
  /** The collector URL, same-origin (`/api/reporting/collect`) or the hub's. */
  readonly collector: string;
  /** This app's site id. */
  readonly site: string;
  readonly consent?: ConsentMode;
  /** Batch size and flush interval; the defaults are the collector's caps. */
  readonly batch?: number;
  readonly flushMs?: number;
  /** For tests: the window to observe and the transport to post with. */
  readonly window?: Window;
  readonly send?: (url: string, body: string) => void;
}

export interface Beacon {
  track(name: string, props?: Record<string, string | number | boolean | null>): void;
  pageView(): void;
  /** The person's answer under `consented`; sets or clears the cookie and remembers it. */
  accept(): void;
  decline(): void;
  answer(): ConsentAnswer;
  visitorId(): string | null;
  flush(): void;
  destroy(): void;
}

const COOKIE = '_rp';
const YEAR = 365 * 24 * 60 * 60;
const NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/;

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function readCookie(doc: Document): { id: string; answer: ConsentAnswer } | null {
  const m = doc.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]*)`));
  if (!m?.[1]) return null;
  const [id, answer] = decodeURIComponent(m[1]).split('.');
  if (!id || !/^[a-f0-9]{32}$/.test(id)) return null;
  return { id, answer: answer === 'a' ? 'accepted' : answer === 'd' ? 'declined' : null };
}

function writeCookie(doc: Document, value: string | null): void {
  doc.cookie =
    value === null
      ? `${COOKIE}=; Max-Age=0; Path=/; SameSite=Lax; Secure`
      : `${COOKIE}=${encodeURIComponent(value)}; Max-Age=${YEAR}; Path=/; SameSite=Lax; Secure`;
}

export function createBeacon(options: BeaconOptions): Beacon {
  const win = options.window ?? window;
  const doc = win.document;
  const mode: ConsentMode = options.consent ?? 'consented';
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

  // Identity: a visitor id only with consent; a session id per tab.
  let cookie = readCookie(doc);
  let answer: ConsentAnswer = cookie?.answer ?? null;
  const declined = () => mode === 'none' || (mode === 'consented' && answer !== 'accepted');
  if (mode === 'always' && !cookie) {
    cookie = { id: randomId(), answer: 'accepted' };
    writeCookie(doc, `${cookie.id}.a`);
  }
  if (declined()) {
    if (cookie && answer !== 'declined') cookie = null;
  }
  let sessionId: string | null = null;
  function inMemorySession(): string {
    if (!sessionId) sessionId = randomId();
    return sessionId;
  }
  function session(): string | null {
    if (declined()) return inMemorySession();
    try {
      const stored = win.sessionStorage.getItem(`${COOKIE}s`);
      if (stored && /^[a-f0-9]{32}$/.test(stored)) return stored;
      const fresh = randomId();
      win.sessionStorage.setItem(`${COOKIE}s`, fresh);
      return fresh;
    } catch {
      return inMemorySession();
    }
  }

  // The queue.
  type Queued = {
    name: string;
    at: number;
    path: string;
    referrer?: string | null;
    props: Record<string, string | number | boolean | null>;
    duration?: number;
  };
  const queue: Queued[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  function flush(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (queue.length === 0) return;
    const events = queue.splice(0, batchSize);
    const body = JSON.stringify({
      site: options.site,
      visitorId: declined() ? null : (cookie?.id ?? null),
      sessionId: session(),
      events,
    });
    try {
      send(options.collector, body);
    } catch {
      // A beacon that cannot leave is dropped; nothing here may throw into the page.
    }
    if (queue.length > 0) flush();
  }
  function push(event: Queued): void {
    queue.push(event);
    if (queue.length >= batchSize) flush();
    else if (!timer) timer = setTimeout(flush, flushMs);
  }

  const pathOf = () => win.location.pathname || '/';
  let currentPath = pathOf();
  let enteredAt = Date.now();
  let lastReferrer: string | null = doc.referrer || null;

  function pageView(): void {
    currentPath = pathOf();
    enteredAt = Date.now();
    push({
      name: 'page.view',
      at: Date.now(),
      path: currentPath,
      referrer: lastReferrer,
      props: {},
    });
    lastReferrer = null;
  }
  function pageLeave(): void {
    const duration = Math.max(0, Math.round((Date.now() - enteredAt) / 1000));
    push({ name: 'page.leave', at: Date.now(), path: currentPath, props: {}, duration });
    flush();
  }
  function track(name: string, props: Record<string, string | number | boolean | null> = {}): void {
    if (!NAME.test(name) || name.startsWith('page.')) return;
    push({ name, at: Date.now(), path: pathOf(), props });
  }

  // History: a SPA navigation is a page view too.
  const history = win.history;
  const pushState = history.pushState.bind(history);
  const replaceState = history.replaceState.bind(history);
  const onNavigate = () => {
    if (pathOf() === currentPath) return;
    pageLeave();
    pageView();
  };
  history.pushState = (...args) => {
    pushState(...args);
    onNavigate();
  };
  history.replaceState = (...args) => {
    replaceState(...args);
    onNavigate();
  };
  const onPop = () => onNavigate();
  const onHide = () => {
    if (doc.visibilityState === 'hidden') pageLeave();
  };
  win.addEventListener('popstate', onPop);
  doc.addEventListener('visibilitychange', onHide);
  win.addEventListener('pagehide', pageLeave);

  pageView();

  return {
    track,
    pageView,
    accept() {
      if (mode !== 'consented') return;
      answer = 'accepted';
      cookie = { id: cookie?.id ?? randomId(), answer };
      writeCookie(doc, `${cookie.id}.a`);
    },
    decline() {
      if (mode !== 'consented') return;
      answer = 'declined';
      cookie = null;
      writeCookie(doc, `${randomId()}.d`);
    },
    answer: () => answer,
    visitorId: () => (declined() ? null : (cookie?.id ?? null)),
    flush,
    destroy() {
      flush();
      history.pushState = pushState;
      history.replaceState = replaceState;
      win.removeEventListener('popstate', onPop);
      doc.removeEventListener('visibilitychange', onHide);
      win.removeEventListener('pagehide', pageLeave);
    },
  };
}
