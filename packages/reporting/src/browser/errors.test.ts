import { describe, expect, it } from 'vitest';
import { createBeacon } from './index.js';

/** A window small enough to hold in one hand, extended from beacon.test.ts's
 * with a `fire` that can pass an event payload — needed here since `error`
 * and `unhandledrejection` listeners read `event.message`/`.error`/`.reason`. */
function fakeWindow(path = '/start') {
  const listeners = new Map<string, Set<(event?: unknown) => void>>();
  const on = (target: string) => (type: string, fn: (event?: unknown) => void) => {
    listeners.set(`${target}:${type}`, (listeners.get(`${target}:${type}`) ?? new Set()).add(fn));
  };
  const off = (target: string) => (type: string, fn: (event?: unknown) => void) =>
    listeners.get(`${target}:${type}`)?.delete(fn);
  const fire = (key: string, event?: unknown) => {
    for (const fn of listeners.get(key) ?? []) fn(event);
  };
  const size = (key: string) => listeners.get(key)?.size ?? 0;
  const doc = {
    cookie: '',
    referrer: '',
    visibilityState: 'visible',
    addEventListener: on('doc'),
    removeEventListener: off('doc'),
  };
  const win = {
    document: doc,
    location: { pathname: path },
    history: {
      pushState: () => {},
      replaceState: () => {},
    },
    navigator: { sendBeacon: () => true },
    fetch: async () => new Response(null, { status: 204 }),
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    addEventListener: on('win'),
    removeEventListener: off('win'),
  };
  return { win: win as unknown as Window, fire, size };
}

function capture() {
  const sent: {
    url: string;
    body: { site: string; errors: { kind: string; message: string; stack?: string | null }[] };
  }[] = [];
  return {
    sent,
    send: (url: string, body: string) => void sent.push({ url, body: JSON.parse(body) }),
  };
}

describe('the beacon: errors', () => {
  it('does not listen unless both errors and errorCollector are set', () => {
    const { win, size } = fakeWindow();
    const b = createBeacon({ collector: '/c', site: 'app', window: win, send: () => {} });
    expect(size('win:error')).toBe(0);
    expect(size('win:unhandledrejection')).toBe(0);
    b.destroy();
  });

  it('sends window.onerror and unhandledrejection through the error collector', () => {
    const { win, fire } = fakeWindow();
    const { sent, send } = capture();
    const b = createBeacon({
      collector: '/c',
      site: 'app',
      errors: true,
      errorCollector: '/api/errors',
      window: win,
      send,
      flushMs: 100_000,
    });
    fire('win:error', {
      message: 'Uncaught TypeError: x is not a function',
      error: Object.assign(new TypeError('x is not a function'), {
        stack: 'TypeError: x is not a function\n    at foo (app.js?v=1:10:5)',
      }),
    });
    fire('win:unhandledrejection', { reason: new RangeError('bad range') });
    b.destroy();
    const posted = sent.find((s) => s.url === '/api/errors');
    expect(posted?.body.site).toBe('app');
    expect(posted?.body.errors.map((e) => e.kind)).toEqual(['TypeError', 'RangeError']);
    expect(posted?.body.errors[0]?.stack).toContain('app.js:10:5');
    expect(posted?.body.errors[0]?.stack).not.toContain('?v=1');
  });

  it('drops a cross-origin "Script error." with nothing else to go on', () => {
    const { win, fire } = fakeWindow();
    const { sent, send } = capture();
    const b = createBeacon({
      collector: '/c',
      site: 'app',
      errors: true,
      errorCollector: '/api/errors',
      window: win,
      send,
      flushMs: 100_000,
    });
    fire('win:error', { message: 'Script error.' });
    b.destroy();
    expect(sent.find((s) => s.url === '/api/errors')).toBeUndefined();
  });

  it('de-duplicates a repeated error and stops at the per-page cap', () => {
    const { win, fire } = fakeWindow();
    const { sent, send } = capture();
    const b = createBeacon({
      collector: '/c',
      site: 'app',
      errors: true,
      errorCollector: '/api/errors',
      window: win,
      send,
      flushMs: 100_000,
    });
    for (let i = 0; i < 10; i += 1) {
      fire('win:error', { message: 'Uncaught Error: loop', error: new Error('loop') });
    }
    for (let i = 0; i < 10; i += 1) {
      fire('win:error', {
        message: `Uncaught Error: distinct ${i}`,
        error: new Error(`distinct ${i}`),
      });
    }
    b.destroy();
    const posted = sent.filter((s) => s.url === '/api/errors').flatMap((s) => s.body.errors);
    expect(posted.length).toBeLessThanOrEqual(5);
    expect(posted.filter((e) => e.message === 'loop')).toHaveLength(1);
  });

  it('destroy() removes both new listeners', () => {
    const { win, size } = fakeWindow();
    const b = createBeacon({
      collector: '/c',
      site: 'app',
      errors: true,
      errorCollector: '/api/errors',
      window: win,
      send: () => {},
    });
    expect(size('win:error')).toBe(1);
    expect(size('win:unhandledrejection')).toBe(1);
    b.destroy();
    expect(size('win:error')).toBe(0);
    expect(size('win:unhandledrejection')).toBe(0);
  });
});
