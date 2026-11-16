import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SENDER_LIMITS, createErrorSender } from './sender.js';

const URL_ = 'https://reporting.test';
const KEY = 'ci_rk_sitekeyfortests';

function harness(
  answer: (call: number) => Response | Promise<Response> = () =>
    Response.json({ accepted: 1 }, { status: 202 }),
) {
  let calls = 0;
  const fetcher = vi.fn<typeof fetch>(async () => answer(++calls));
  const lines: string[] = [];
  const sender = createErrorSender({
    url: URL_,
    siteKey: KEY,
    fetch: fetcher,
    log: (line) => lines.push(line),
  });
  const bodies = () =>
    fetcher.mock.calls.map(
      ([, init]) => JSON.parse(String(init?.body)) as { errors: Record<string, unknown>[] },
    );
  return { fetcher, sender, lines, bodies };
}

describe('createErrorSender', () => {
  it('posts a batch to /v1/errors with the site key as the bearer', async () => {
    const h = harness();
    await h.sender.send({ message: 'boom', runtime: 'edge', release: 'v1', requestId: 'r1' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://reporting.test/v1/errors');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
    const [report] = h.bodies()[0]?.errors ?? [];
    expect(report).toMatchObject({
      message: 'boom',
      runtime: 'edge',
      release: 'v1',
      requestId: 'r1',
    });
    expect(typeof report?.occurredAt).toBe('string');
    expect(Object.keys(report ?? {})).not.toContain('site');
  });

  it('batches reports sent together, at most 20 a request', async () => {
    const h = harness();
    const sends = Array.from({ length: 45 }, (_, i) =>
      h.sender.send({ message: `boom ${i}`, runtime: 'server' }),
    );
    await Promise.all(sends);
    expect(h.bodies().map((b) => b.errors.length)).toEqual([20, 20, 5]);
  });

  it('keeps every request body within 64 KB', async () => {
    const h = harness();
    const big = 'x'.repeat(SENDER_LIMITS.stack);
    await Promise.all(
      Array.from({ length: 10 }, () =>
        h.sender.send({ message: 'm', stack: big, runtime: 'server' }),
      ),
    );
    const sizes = h.fetcher.mock.calls.map(
      ([, init]) => new TextEncoder().encode(String(init?.body)).byteLength,
    );
    expect(sizes.length).toBeGreaterThan(1);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(SENDER_LIMITS.bodyBytes);
    expect(h.bodies().flatMap((b) => b.errors)).toHaveLength(10);
  });

  it('cuts a message and a stack where the backend would, and stamps release and color', async () => {
    const h = harness();
    const sender = createErrorSender({
      url: URL_,
      siteKey: KEY,
      fetch: h.fetcher,
      release: 'r9',
      color: 'blue',
    });
    await sender.send({ message: 'm'.repeat(5000), stack: 's'.repeat(40000), runtime: 'server' });
    const [report] = h.bodies()[0]?.errors ?? [];
    expect(String(report?.message)).toHaveLength(SENDER_LIMITS.message);
    expect(String(report?.stack)).toHaveLength(SENDER_LIMITS.stack);
    expect(report).toMatchObject({ release: 'r9', color: 'blue' });
  });

  it('capture reads the class name, message and stack of a thrown value', async () => {
    const h = harness();
    const error = new TypeError('cannot read x');
    await h.sender.capture(error, { runtime: 'edge' });
    await h.sender.capture('a string', {});
    await h.sender.capture(null);
    const reports = h.bodies().flatMap((b) => b.errors);
    expect(reports[0]).toMatchObject({
      kind: 'TypeError',
      message: 'cannot read x',
      stack: error.stack,
      runtime: 'edge',
    });
    expect(reports[1]).toMatchObject({ kind: 'string', message: 'a string', runtime: 'server' });
    expect(reports[2]).toMatchObject({ kind: 'null', message: 'null' });
  });

  it('a 401 is reported once and nothing is sent or retried after it', async () => {
    const h = harness(() =>
      Response.json({ error: { code: 'unauthorized', message: 'no' } }, { status: 401 }),
    );
    await h.sender.send({ message: 'a', runtime: 'server' });
    await h.sender.send({ message: 'b', runtime: 'server' });
    await h.sender.capture(new Error('c'));
    await h.sender.flush();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(h.lines).toEqual([
      'reporting: error reports refused: the site key is unknown or revoked',
    ]);
  });

  it('never throws or rejects: a refusal, a lost connection and a timeout are logged as fixed text', async () => {
    const h = harness((call) => {
      if (call === 1) return Response.json({ error: { code: 'unavailable' } }, { status: 503 });
      throw new TypeError('fetch failed with secret detail');
    });
    await expect(h.sender.send({ message: 'a secret message', runtime: 'server' })).resolves.toBe(
      undefined,
    );
    await expect(h.sender.send({ message: 'b', runtime: 'server' })).resolves.toBe(undefined);
    const slow = createErrorSender({
      url: URL_,
      siteKey: KEY,
      timeoutMs: 20,
      log: (line) => h.lines.push(line),
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await slow.send({ message: 'c', runtime: 'server' });
    expect(h.lines).toEqual([
      'reporting: error reports refused: status 503',
      'reporting: error reports dropped: TypeError',
      'reporting: error reports dropped: the request timed out',
    ]);
    expect(h.lines.join('\n')).not.toContain(KEY);
    expect(h.lines.join('\n')).not.toContain('secret');
  });

  it('sends person from a report and from a capture context', async () => {
    const h = harness();
    await h.sender.send({ message: 'boom', runtime: 'edge', person: 'u-1' });
    await h.sender.capture(new Error('bang'), { person: 'sess-2' });
    const sent = h.bodies().flatMap((b) => b.errors);
    expect(sent.map((r) => r.person)).toEqual(['u-1', 'sess-2']);
  });

  it('drops a person that is empty, over 256 characters or not a string, and still sends the report', async () => {
    const h = harness();
    await h.sender.send({ message: 'a', runtime: 'server', person: '' });
    await h.sender.send({ message: 'b', runtime: 'server', person: 'x'.repeat(257) });
    // biome-ignore lint/suspicious/noExplicitAny: a caller outside TypeScript
    await h.sender.send({ message: 'c', runtime: 'server', person: 42 as any });
    await h.sender.send({ message: 'd', runtime: 'server', person: 'y'.repeat(256) });
    const sent = h.bodies().flatMap((b) => b.errors);
    expect(sent.map((r) => r.message)).toEqual(['a', 'b', 'c', 'd']);
    for (const r of sent.slice(0, 3)) expect(Object.keys(r)).not.toContain('person');
    expect(sent[3]?.person).toBe('y'.repeat(256));
  });

  it('sends context and retryOf from a report and from a capture context', async () => {
    const h = harness();
    await h.sender.send({
      message: 'a',
      runtime: 'server',
      retryOf: 'req-1',
      context: { company: 'acme', mcp: 'mcp_7', account: 'acc:9.x-y' },
    });
    await h.sender.capture(new Error('b'), { retryOf: 'req-2', context: { account: 'a1' } });
    const sent = h.bodies().flatMap((b) => b.errors);
    expect(sent.map((r) => r.retryOf)).toEqual(['req-1', 'req-2']);
    expect(sent.map((r) => r.context)).toEqual([
      { company: 'acme', mcp: 'mcp_7', account: 'acc:9.x-y' },
      { account: 'a1' },
    ]);
  });

  it('drops an invalid context id, keeps the valid ones, and still sends the report', async () => {
    const h = harness();
    await h.sender.send({
      message: 'a',
      runtime: 'server',
      context: {
        company: 'ann@example.com',
        mcp: 'ok-1',
        account: 'x'.repeat(129),
        other: 'nope',
        // biome-ignore lint/suspicious/noExplicitAny: a caller outside TypeScript
      } as any,
    });
    await h.sender.send({ message: 'b', runtime: 'server', context: { company: '' } });
    // biome-ignore lint/suspicious/noExplicitAny: a caller outside TypeScript
    await h.sender.send({ message: 'c', runtime: 'server', context: { mcp: 7 as any } });
    await h.sender.send({ message: 'd', runtime: 'server', context: { company: 'y'.repeat(128) } });
    const sent = h.bodies().flatMap((b) => b.errors);
    expect(sent.map((r) => r.message)).toEqual(['a', 'b', 'c', 'd']);
    expect(sent[0]?.context).toEqual({ mcp: 'ok-1' });
    expect(Object.keys(sent[1] ?? {})).not.toContain('context');
    expect(Object.keys(sent[2] ?? {})).not.toContain('context');
    expect(sent[3]?.context).toEqual({ company: 'y'.repeat(128) });
  });

  it('cuts nothing: a retryOf over 128 characters is cut like requestId, an empty one is dropped', async () => {
    const h = harness();
    await h.sender.send({ message: 'a', runtime: 'server', retryOf: '' });
    await h.sender.send({ message: 'b', runtime: 'server', retryOf: 'r'.repeat(200) });
    const sent = h.bodies().flatMap((b) => b.errors);
    expect(Object.keys(sent[0] ?? {})).not.toContain('retryOf');
    expect(sent[1]?.retryOf).toBe('r'.repeat(SENDER_LIMITS.requestId));
  });

  it('drops a report with no message or a bad runtime, and a bad url, without throwing', async () => {
    const h = harness();
    await h.sender.send({ message: '', runtime: 'server' });
    // biome-ignore lint/suspicious/noExplicitAny: a caller outside TypeScript
    await h.sender.send({ message: 'x', runtime: 'worker' as any });
    // biome-ignore lint/suspicious/noExplicitAny: a caller outside TypeScript
    await h.sender.send(null as any);
    expect(h.fetcher).not.toHaveBeenCalled();
    const lines: string[] = [];
    const bad = createErrorSender({ url: 'not a url', siteKey: KEY, log: (l) => lines.push(l) });
    await bad.send({ message: 'x', runtime: 'server' });
    expect(lines).toEqual(['reporting: error reports dropped: no fetch or no valid url']);
  });

  it('holds at most maxQueue reports while waiting', async () => {
    const h = harness();
    const lines: string[] = [];
    const sender = createErrorSender({
      url: URL_,
      siteKey: KEY,
      fetch: h.fetcher,
      maxQueue: 3,
      delayMs: 10,
      log: (l) => lines.push(l),
    });
    for (let i = 0; i < 5; i++) void sender.send({ message: `m${i}`, runtime: 'server' });
    await sender.flush();
    expect(h.bodies().flatMap((b) => b.errors)).toHaveLength(3);
    expect(lines).toEqual(['reporting: error reports dropped: the queue is full (1 so far)']);
  });

  it('flush sends what is queued at once and waits for it', async () => {
    const h = harness();
    const sender = createErrorSender({
      url: URL_,
      siteKey: KEY,
      fetch: h.fetcher,
      delayMs: 60_000,
    });
    void sender.send({ message: 'm', runtime: 'server' });
    expect(h.fetcher).not.toHaveBeenCalled();
    await sender.flush();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('the package source', () => {
  it('imports nothing from Node and no package, so a Worker can load it', () => {
    const dir = new URL('./', import.meta.url);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const source = readFileSync(new URL(name, dir), 'utf8');
      const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      for (const specifier of imports) expect(specifier, `${name}: ${specifier}`).toMatch(/^\.\//);
      expect(source, name).not.toMatch(/\bprocess\.|\bBuffer\b|require\(/);
    }
  });
});
