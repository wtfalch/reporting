import { describe, expect, it } from 'vitest';
import { createBeacon } from './index.js';

/** A window small enough to hold in one hand: location, history, cookies, storage, events. */
function fakeWindow(path = '/start', cookie = '') {
  const listeners = new Map<string, Set<() => void>>();
  const on = (target: string) => (type: string, fn: () => void) => {
    listeners.set(`${target}:${type}`, (listeners.get(`${target}:${type}`) ?? new Set()).add(fn));
  };
  const off = (target: string) => (type: string, fn: () => void) =>
    listeners.get(`${target}:${type}`)?.delete(fn);
  const fire = (key: string) => {
    for (const fn of listeners.get(key) ?? []) fn();
  };
  const store = new Map<string, string>();
  const doc = {
    _cookie: cookie,
    get cookie() {
      return this._cookie;
    },
    set cookie(v: string) {
      const [pair] = v.split(';');
      const [k, val] = (pair ?? '').split('=');
      const rest = this._cookie.split('; ').filter((c) => c && !c.startsWith(`${k}=`));
      if (!v.includes('Max-Age=0')) rest.push(`${k}=${val}`);
      this._cookie = rest.join('; ');
    },
    referrer: 'https://ref.example/x',
    visibilityState: 'visible',
    addEventListener: on('doc'),
    removeEventListener: off('doc'),
  };
  const win = {
    document: doc,
    location: { pathname: path },
    history: {
      pushState: (_s: unknown, _t: string, url?: string) => {
        if (url) win.location.pathname = url;
      },
      replaceState: (_s: unknown, _t: string, url?: string) => {
        if (url) win.location.pathname = url;
      },
    },
    navigator: { sendBeacon: () => true },
    fetch: async () => new Response(null, { status: 204 }),
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    addEventListener: on('win'),
    removeEventListener: off('win'),
  };
  return { win: win as unknown as Window, doc, fire };
}

function capture() {
  const sent: {
    url: string;
    body: {
      site: string;
      visitorId: string | null;
      sessionId: string | null;
      events: { name: string; path: string; referrer?: string | null; duration?: number }[];
    };
  }[] = [];
  return {
    sent,
    send: (url: string, body: string) => void sent.push({ url, body: JSON.parse(body) }),
  };
}

describe('the beacon', () => {
  it('records a page view on load with the referrer, batches, and sends no visitor id before consent', () => {
    const { win } = fakeWindow();
    const { sent, send } = capture();
    const b = createBeacon({
      collector: '/api/reporting/collect',
      site: 'app',
      window: win,
      send,
      flushMs: 100_000,
    });
    b.track('button.clicked', { where: 'header' });
    b.track('Bad Name');
    b.track('page.view');
    b.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.site).toBe('app');
    expect(sent[0]?.body.visitorId).toBeNull();
    expect(sent[0]?.body.sessionId).toMatch(/^[a-f0-9]{32}$/);
    expect(sent[0]?.body.events.map((e) => e.name)).toEqual(['page.view', 'button.clicked']);
    expect(sent[0]?.body.events[0]?.referrer).toBe('https://ref.example/x');
    expect(sent[0]?.body.events[0]?.path).toBe('/start');
    expect(b.answer()).toBeNull();
    expect(b.visitorId()).toBeNull();
    b.destroy();
  });

  it('sets the cookie on accept, clears it on decline, and remembers the answer across loads', () => {
    const { win, doc } = fakeWindow();
    const { send } = capture();
    const b = createBeacon({ collector: '/c', site: 'app', window: win, send, flushMs: 100_000 });
    b.accept();
    expect(b.visitorId()).toMatch(/^[a-f0-9]{32}$/);
    expect(doc.cookie).toMatch(/_rp=[a-f0-9]{32}\.a/);
    b.destroy();
    const again = createBeacon({
      collector: '/c',
      site: 'app',
      window: fakeWindow('/', doc.cookie).win,
      send,
      flushMs: 100_000,
    });
    expect(again.answer()).toBe('accepted');
    expect(again.visitorId()).toBe(b.visitorId());
    again.decline();
    expect(again.answer()).toBe('declined');
    expect(again.visitorId()).toBeNull();
    again.destroy();
  });

  it('under none there is never a cookie; under always there is one without asking', () => {
    const none = fakeWindow();
    const { send } = capture();
    const b = createBeacon({
      collector: '/c',
      site: 'app',
      window: none.win,
      send,
      consent: 'none',
    });
    b.accept();
    expect(none.doc.cookie).toBe('');
    expect(b.visitorId()).toBeNull();
    b.destroy();
    const always = fakeWindow();
    const a = createBeacon({
      collector: '/c',
      site: 'app',
      window: always.win,
      send,
      consent: 'always',
    });
    expect(always.doc.cookie).toMatch(/_rp=/);
    expect(a.visitorId()).toMatch(/^[a-f0-9]{32}$/);
    a.destroy();
  });

  it('a history change is a leave with duration then a view; batches split at twenty', () => {
    const { win } = fakeWindow('/one');
    const { sent, send } = capture();
    const b = createBeacon({ collector: '/c', site: 'app', window: win, send, flushMs: 100_000 });
    win.history.pushState(null, '', '/two');
    b.flush();
    const names = sent.flatMap((s) => s.body.events.map((e) => `${e.name}:${e.path}`));
    expect(names).toEqual(['page.view:/one', 'page.leave:/one', 'page.view:/two']);
    expect(
      sent.flatMap((s) => s.body.events).find((e) => e.name === 'page.leave')?.duration,
    ).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 45; i += 1) b.track('x.y');
    b.flush();
    expect(Math.max(...sent.map((s) => s.body.events.length))).toBeLessThanOrEqual(20);
    b.destroy();
  });
});
