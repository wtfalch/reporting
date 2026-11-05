import type { OutgoingMail, SendResult, Transport } from '@wtfalch/mailer';
import { reportingEvents } from '@wtfalch/reporting-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ALERT_LIMITS,
  RAISED_FACTOR,
  RAISED_MIN,
  baselineOf,
  createAlerts,
  newKindMail,
} from './alerts.js';
import { createReportingHandler } from './server.js';
import { tenantIdOf } from './site-keys.js';
import { type TestDb, memoryLog, testDb } from './test/db.js';

const OPERATOR = 'operator-key-for-tests';
const TENANT = tenantIdOf('org_acme');
const BASE = 'https://reporting.test';
const BY = { class: 'human', id: 'person-1' } as const;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MINUTE = 60_000;

let t: TestDb;
let log: ReturnType<typeof memoryLog>;
let clock: Date;
let handle: (request: Request) => Promise<Response>;
let keys: Record<'production' | 'stage', string>;

/** A transport that keeps what it was given, and fails for the addresses in `refuse`. */
function memoryTransport() {
  const sent: OutgoingMail[] = [];
  const refuse = new Set<string>();
  const transport: Transport & { sent: OutgoingMail[]; refuse: Set<string> } = {
    sent,
    refuse,
    async send(message): Promise<SendResult> {
      if (refuse.has(message.to)) throw new Error(`refused ${message.to}`);
      sent.push(message);
      return { id: String(sent.length), transport: 'mailpit' };
    },
  };
  return transport;
}
let mail: ReturnType<typeof memoryTransport>;

beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t.close();
});

function call(method: string, path: string, body?: unknown, key = OPERATOR): Promise<Response> {
  return handle(
    new Request(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function mint(site: string, environment: 'production' | 'stage'): Promise<string> {
  const res = await call('POST', '/v1/site-keys', {
    name: `${site}-${environment}`,
    site,
    environment,
  });
  return ((await res.json()) as { secret: string }).secret;
}

function report(environment: 'production' | 'stage', errors: unknown[]): Promise<Response> {
  return call('POST', '/v1/errors', { errors }, keys[environment]);
}

type TestRule = ReturnType<typeof rule>;

/** PUT /v1/alert-rules. A body with `rules` (one switch each) is turned into Boule's shape first. */
function rules(body: { rules?: TestRule[] } & Record<string, unknown>): Promise<Response> {
  if (!body.rules) return call('PUT', '/v1/alert-rules', body);
  const { rules: list, ...rest } = body;
  const choices = {
    live: { newKind: false, wentUp: false },
    work: { newKind: false, wentUp: false },
  };
  for (const r of list) {
    choices[r.environment === 'production' ? 'live' : 'work'][
      r.kind === 'new_kind' ? 'newKind' : 'wentUp'
    ] = r.enabled;
  }
  return call('PUT', '/v1/alert-rules', {
    ...rest,
    recipients: [...new Set(list.flatMap((r) => r.recipients))],
    links: { live: LINK, work: LINK },
    choices,
  });
}

const rule = (
  environment: 'production' | 'stage',
  kind: 'new_kind' | 'went_up',
  recipients = ['owner@acme.example'],
  enabled = true,
) => ({ environment, kind, enabled, recipients });
const LINK = 'https://boule.acme.example/errors';

function alerts() {
  return createAlerts({
    db: t.db,
    mail: { transport: mail, from: 'Acme <no-reply@acme.example>' },
    log,
    now: () => clock,
    everyMs: 0,
  });
}

/** `n` error events for the site's environment, spread over the hour that starts at `at`. */
async function events(
  environment: 'production' | 'stage',
  at: number,
  n: number,
  release?: string,
) {
  if (n === 0) return;
  await t.db.insert(reportingEvents).values(
    Array.from({ length: n }, (_, i) => ({
      occurredAt: new Date(at + Math.floor((i * HOUR) / n)),
      level: 'error',
      kind: 'error.server',
      site: 'shop',
      environment,
      release: release ?? null,
      message: 'Error',
      data: { fingerprint: '0'.repeat(32), runtime: 'server' },
    })),
  );
}

beforeEach(async () => {
  for (const table of [
    'reporting_events',
    'reporting_error_tenants',
    'reporting_errors',
    'reporting_site_keys',
    'reporting_alert_rules',
    'reporting_alerts',
    'reporting_releases',
  ]) {
    await t.exec(`delete from ${table}`);
  }
  log = memoryLog();
  mail = memoryTransport();
  clock = new Date('2026-11-10T12:00:00.000Z');
  handle = createReportingHandler({
    db: t.db,
    operatorKey: OPERATOR,
    tenantId: TENANT,
    log,
    now: () => clock,
  });
  keys = { production: await mint('shop', 'production'), stage: await mint('shop', 'stage') };
});

describe('baselineOf: the rule of Boule W5.2', () => {
  const since = Date.UTC(2026, 10, 9, 12);
  const now = since + DAY;
  it('names the constants', () => {
    expect([RAISED_FACTOR, RAISED_MIN]).toEqual([3, 10]);
  });
  it('24 in 24 hours over a normal of 10 is not raised; 72 is', () => {
    const daily = [8, 10, 12, 9, 11, 10, 10, 13];
    expect(baselineOf({ sinceMs: since, nowMs: now, daily, sinceRelease: 24 })).toEqual({
      sinceRelease: 24,
      normalPerDay: 10,
      raised: false,
    });
    expect(baselineOf({ sinceMs: since, nowMs: now, daily, sinceRelease: 72 }).raised).toBe(true);
  });
  it('days of zeros before the first error are not history', () => {
    const r = baselineOf({
      sinceMs: since,
      nowMs: now,
      daily: [0, 0, 0, 0, 0, 0, 5, 6],
      sinceRelease: 72,
    });
    expect(r).toMatchObject({ normalPerDay: null, raised: false });
  });
  it('a normal of 0 raises at RAISED_MIN alone', () => {
    const z = [0, 0, 0, 0, 0, 0, 0, 0];
    expect(baselineOf({ sinceMs: since, nowMs: now, daily: z, sinceRelease: 10 }).raised).toBe(
      true,
    );
    expect(baselineOf({ sinceMs: since, nowMs: now, daily: z, sinceRelease: 9 }).raised).toBe(
      false,
    );
  });
  it('a release 30 minutes old counts as one hour', () => {
    const daily = Array(8).fill(100);
    expect(
      baselineOf({ sinceMs: since, nowMs: since + 30 * MINUTE, daily, sinceRelease: 10 }),
    ).toMatchObject({ normalPerDay: 100, raised: false });
  });
  it('raises at exactly the factor', () => {
    const daily = Array(8).fill(10);
    expect(baselineOf({ sinceMs: since, nowMs: now, daily, sinceRelease: 29 }).raised).toBe(false);
    expect(baselineOf({ sinceMs: since, nowMs: now, daily, sinceRelease: 30 }).raised).toBe(true);
  });
});

describe('the alert-rules routes', () => {
  const OFF = { newKind: false, wentUp: false };
  it('reads the four switches, all off, before anything is saved', async () => {
    const res = await call('GET', '/v1/alert-rules?site=shop');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      site: 'shop',
      name: null,
      recipients: [],
      links: { live: null, work: null },
      choices: { live: OFF, work: OFF },
      updatedAt: null,
    });
  });

  it('saves the four switches as Boule sends them, with an audit row', async () => {
    const res = await rules({
      site: 'shop',
      name: 'Shop',
      recipients: ['A@Acme.example'],
      links: { live: 'https://boule.acme.example/errors', work: null },
      choices: { live: { newKind: true, wentUp: true }, work: { newKind: true, wentUp: false } },
      by: BY,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      site: 'shop',
      name: 'Shop',
      recipients: ['a@acme.example'],
      links: { live: 'https://boule.acme.example/errors', work: null },
      choices: { live: { newKind: true, wentUp: true }, work: { newKind: true, wentUp: false } },
      updatedAt: clock.toISOString(),
    });
    const audit = await t.query(
      "select operation, site, actor_id from audit_events where operation = 'alert_rule.set' order by id desc limit 1",
    );
    expect(audit).toEqual([{ operation: 'alert_rule.set', site: 'shop', actor_id: 'person-1' }]);
    // Leaving out name and links keeps them.
    const again = await rules({
      site: 'shop',
      recipients: ['a@acme.example'],
      choices: { live: OFF, work: OFF },
      by: BY,
    });
    expect(await again.json()).toMatchObject({
      name: 'Shop',
      links: { live: 'https://boule.acme.example/errors' },
      choices: { live: OFF, work: OFF },
    });
  });

  it('refuses an email that is on with no one to get it, a bad address, a missing copy, another key and no tenant', async () => {
    const on = { live: { newKind: true, wentUp: false }, work: OFF };
    const put = (body: object) => rules({ site: 'shop', by: BY, ...body }).then((r) => r.status);
    expect(await put({ recipients: [], choices: on })).toBe(400);
    expect(await put({ recipients: [], choices: { live: OFF, work: OFF } })).toBe(200);
    expect(await put({ recipients: ['not an address'], choices: on })).toBe(400);
    expect(await put({ recipients: ['a@acme.example'], choices: { live: OFF } })).toBe(400);
    expect(await put({ recipients: ['a@acme.example'], choices: { ...on, staging: OFF } })).toBe(
      400,
    );
    expect((await call('GET', '/v1/alert-rules?site=shop', undefined, 'wrong')).status).toBe(401);
    handle = createReportingHandler({ db: t.db, operatorKey: OPERATOR, log, now: () => clock });
    expect(await put({ recipients: ['a@acme.example'], choices: on })).toBe(503);
  });

  it('records a release, and refuses one far in the future', async () => {
    const ok = await call('POST', '/v1/releases', {
      site: 'shop',
      environment: 'production',
      release: '1.7',
      since: '2026-11-10T10:00:00Z',
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      site: 'shop',
      environment: 'production',
      release: '1.7',
      since: '2026-11-10T10:00:00.000Z',
    });
    const later = await call('POST', '/v1/releases', {
      site: 'shop',
      environment: 'production',
      release: '1.8',
      since: '2026-11-11T10:00:00Z',
    });
    expect(later.status).toBe(400);
  });
});

describe('a new kind of error', () => {
  it('mails once per kind, never per event', async () => {
    await rules({
      site: 'shop',
      name: 'Shop',
      rules: [rule('production', 'new_kind', ['a@acme.example', 'b@acme.example'])],
      by: BY,
    });
    clock = new Date(clock.getTime() + MINUTE);
    await report('production', [
      { kind: 'TypeError', message: 'x is undefined', runtime: 'server', release: '1.7' },
      { kind: 'TypeError', message: 'x is undefined', runtime: 'server', release: '1.7' },
    ]);
    const a = alerts();
    expect(await a.tick()).toEqual({ sent: 1, failed: 0 });
    expect(mail.sent.map((m) => m.to).sort()).toEqual(['a@acme.example', 'b@acme.example']);
    expect(mail.sent[0]).toMatchObject({
      from: 'Acme <no-reply@acme.example>',
      subject: 'New error in Shop (live)',
    });
    expect(mail.sent[0]?.text).toContain('TypeError: x is undefined');
    expect(mail.sent[0]?.text).toContain('https://boule.acme.example/errors');

    await report('production', [
      { kind: 'TypeError', message: 'x is undefined', runtime: 'server' },
    ]);
    expect(await a.tick()).toEqual({ sent: 0, failed: 0 });
    // Another host, or a fresh process, decides the same: the row is claimed already.
    expect(await alerts().tick()).toEqual({ sent: 0, failed: 0 });

    await report('production', [{ kind: 'RangeError', message: 'too far', runtime: 'server' }]);
    expect(await a.tick()).toEqual({ sent: 1, failed: 0 });
    expect(mail.sent).toHaveLength(4);
  });

  it('does not mail a group first seen before the rule was turned on', async () => {
    await report('production', [{ kind: 'TypeError', message: 'old', runtime: 'server' }]);
    clock = new Date(clock.getTime() + MINUTE);
    await rules({ site: 'shop', rules: [rule('production', 'new_kind')], by: BY });
    expect(await alerts().tick()).toEqual({ sent: 0, failed: 0 });
    // Saving again while it stays on keeps the time it went on.
    clock = new Date(clock.getTime() + MINUTE);
    await rules({
      site: 'shop',
      rules: [rule('production', 'new_kind', ['c@acme.example'])],
      by: BY,
    });
    expect(await alerts().tick()).toEqual({ sent: 0, failed: 0 });
  });

  it('keeps live and the workspace apart', async () => {
    await rules({
      site: 'shop',
      name: 'Shop',
      rules: [rule('stage', 'new_kind', ['dev@acme.example'])],
      by: BY,
    });
    clock = new Date(clock.getTime() + MINUTE);
    await report('production', [{ kind: 'TypeError', message: 'same', runtime: 'server' }]);
    const a = alerts();
    expect(await a.tick()).toEqual({ sent: 0, failed: 0 });
    await report('stage', [{ kind: 'TypeError', message: 'same', runtime: 'server' }]);
    expect(await a.tick()).toEqual({ sent: 1, failed: 0 });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({
      to: 'dev@acme.example',
      subject: 'New error in Shop (workspace)',
    });
  });

  it('sends nothing for a rule that is off, or turned off', async () => {
    await rules({
      site: 'shop',
      rules: [rule('production', 'new_kind', ['a@acme.example'], false)],
      by: BY,
    });
    clock = new Date(clock.getTime() + MINUTE);
    await report('production', [{ kind: 'TypeError', message: 'one', runtime: 'server' }]);
    expect(await alerts().tick()).toEqual({ sent: 0, failed: 0 });
    expect(mail.sent).toHaveLength(0);
    expect(await t.query('select * from reporting_alerts')).toHaveLength(0);
  });

  it('logs a failed send without the address, tries again a few times, then stops', async () => {
    await rules({
      site: 'shop',
      rules: [rule('production', 'new_kind', ['ok@acme.example', 'bad@acme.example'])],
      by: BY,
    });
    clock = new Date(clock.getTime() + MINUTE);
    await report('production', [{ kind: 'TypeError', message: 'one', runtime: 'server' }]);
    mail.refuse.add('bad@acme.example');
    const a = alerts();
    expect(await a.tick()).toEqual({ sent: 0, failed: 1 });
    const failures = log.lines.filter((l) => l.msg === 'reporting: alert mail failed');
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures)).not.toContain('acme.example');
    // Too soon to try again.
    expect(await a.tick()).toEqual({ sent: 0, failed: 0 });
    for (let i = 1; i < ALERT_LIMITS.attempts; i++) {
      clock = new Date(clock.getTime() + ALERT_LIMITS.retryAfterMs + MINUTE);
      expect(await a.tick()).toEqual({ sent: 0, failed: 1 });
    }
    clock = new Date(clock.getTime() + ALERT_LIMITS.retryAfterMs + MINUTE);
    expect(await a.tick()).toEqual({ sent: 0, failed: 0 });
    // The one who took it got it once; the one who did not was tried three times in all.
    expect(mail.sent.map((m) => m.to)).toEqual(['ok@acme.example']);
    expect(log.lines.filter((l) => l.msg === 'reporting: alert mail failed')).toHaveLength(
      ALERT_LIMITS.attempts,
    );
    const [row] = await t.query('select status, attempts, delivered from reporting_alerts');
    expect(row).toMatchObject({
      status: 'failed',
      attempts: ALERT_LIMITS.attempts,
      delivered: ['ok@acme.example'],
    });
  });

  it('a retry that succeeds marks the mail sent', async () => {
    await rules({
      site: 'shop',
      rules: [rule('production', 'new_kind', ['bad@acme.example'])],
      by: BY,
    });
    clock = new Date(clock.getTime() + MINUTE);
    await report('production', [{ kind: 'TypeError', message: 'one', runtime: 'server' }]);
    mail.refuse.add('bad@acme.example');
    const a = alerts();
    expect(await a.tick()).toEqual({ sent: 0, failed: 1 });
    mail.refuse.clear();
    clock = new Date(clock.getTime() + ALERT_LIMITS.retryAfterMs + MINUTE);
    expect(await a.tick()).toEqual({ sent: 1, failed: 0 });
    clock = new Date(clock.getTime() + ALERT_LIMITS.retryAfterMs + MINUTE);
    expect(await a.tick()).toEqual({ sent: 0, failed: 0 });
    expect(mail.sent).toHaveLength(1);
  });

  it('with no mail set up, claims nothing and says so once', async () => {
    await rules({ site: 'shop', rules: [rule('production', 'new_kind')], by: BY });
    clock = new Date(clock.getTime() + MINUTE);
    await report('production', [{ kind: 'TypeError', message: 'one', runtime: 'server' }]);
    const a = createAlerts({ db: t.db, mail: null, log, now: () => clock, everyMs: 0 });
    expect((await a.tick()).skipped).toBe('no-mail');
    expect((await a.tick()).skipped).toBe('no-mail');
    expect(log.lines.filter((l) => l.level === 'warn')).toHaveLength(1);
    expect(await t.query('select * from reporting_alerts')).toHaveLength(0);
  });
});

describe('a send that never answers', () => {
  it('ends at the time limit, marks the mail failed, and the next tick runs', async () => {
    await rules({
      site: 'shop',
      rules: [rule('production', 'new_kind', ['a@acme.example'])],
      by: BY,
    });
    clock = new Date(clock.getTime() + MINUTE);
    await report('production', [{ kind: 'TypeError', message: 'one', runtime: 'server' }]);
    const hung: Transport = { send: () => new Promise<SendResult>(() => undefined) };
    const a = createAlerts({
      db: t.db,
      mail: { transport: hung, from: 'Acme <no-reply@acme.example>' },
      log,
      now: () => clock,
      everyMs: 0,
      sendTimeoutMs: 50,
    });
    expect(await a.tick()).toEqual({ sent: 0, failed: 1 });
    const [row] = await t.query('select status, delivered from reporting_alerts');
    expect(row).toMatchObject({ status: 'failed', delivered: [] });
    const failures = log.lines.filter((l) => l.msg === 'reporting: alert mail failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.obj).toMatchObject({ err: 'SendTimeoutError' });
    // The tick did not stay marked as running: the retry runs and is judged on its own.
    clock = new Date(clock.getTime() + ALERT_LIMITS.retryAfterMs + MINUTE);
    expect(await a.tick()).toEqual({ sent: 0, failed: 1 });
    expect(ALERT_LIMITS.sendTimeoutMs).toBe(15_000);
  });
});

describe('errors went up after a release', () => {
  // The release went up at 2026-11-09T12:00Z; normal is 10 a day over the 8 days before.
  const since = Date.UTC(2026, 10, 9, 12);
  const dayStart = Date.UTC(2026, 10, 9);
  async function history(environment: 'production' | 'stage') {
    for (let d = 1; d <= 8; d++) await events(environment, dayStart - d * DAY, 10, '1.6');
  }
  async function release(environment: 'production' | 'stage', name: string, at: number) {
    const res = await call('POST', '/v1/releases', {
      site: 'shop',
      environment,
      release: name,
      since: new Date(at).toISOString(),
    });
    expect(res.status).toBe(200);
  }

  it('mails once per release, when the rate is three times normal', async () => {
    await rules({ site: 'shop', name: 'Shop', rules: [rule('production', 'went_up')], by: BY });
    await history('production');
    await release('production', '1.7', since);
    clock = new Date(since + DAY);
    // 29 in a day over a normal of 10: not yet.
    await events('production', since, 29, '1.7');
    const a = alerts();
    expect(await a.tick()).toEqual({ sent: 0, failed: 0 });
    await events('production', since + 2 * HOUR, 1, '1.7');
    expect(await a.tick()).toEqual({ sent: 1, failed: 0 });
    expect(mail.sent[0]?.subject).toBe('Errors went up after release 1.7 of Shop (live)');
    expect(mail.sent[0]?.text).toContain('30 errors since release 1.7');
    expect(mail.sent[0]?.text).toContain('a normal day had 10');
    await events('production', since + 3 * HOUR, 50, '1.7');
    expect(await a.tick()).toEqual({ sent: 0, failed: 0 });

    // The next release is judged on its own.
    const next = since + 2 * DAY;
    clock = new Date(next + HOUR);
    await release('production', '1.8', next);
    await events('production', next, 40, '1.8');
    expect(await a.tick()).toEqual({ sent: 1, failed: 0 });
    expect(mail.sent.map((m) => m.subject)).toEqual([
      'Errors went up after release 1.7 of Shop (live)',
      'Errors went up after release 1.8 of Shop (live)',
    ]);
  });

  it('keeps live and the workspace apart', async () => {
    await rules({ site: 'shop', rules: [rule('stage', 'went_up', ['dev@acme.example'])], by: BY });
    await history('production');
    await release('production', '1.7', since);
    await release('stage', '1.7', since);
    clock = new Date(since + DAY);
    await events('production', since, 100, '1.7');
    const a = alerts();
    expect(await a.tick()).toEqual({ sent: 0, failed: 0 });
    await history('stage');
    await events('stage', since, 100, '1.7');
    expect(await a.tick()).toEqual({ sent: 1, failed: 0 });
    expect(mail.sent[0]).toMatchObject({ to: 'dev@acme.example' });
    expect(mail.sent[0]?.subject).toContain('(workspace)');
  });

  it('with no release recorded, counts from the release of the newest error', async () => {
    await rules({ site: 'shop', rules: [rule('production', 'went_up')], by: BY });
    await history('production');
    clock = new Date(since + DAY);
    await events('production', since, 40, '1.7');
    expect(await alerts().tick()).toEqual({ sent: 1, failed: 0 });
  });

  it('sends nothing for a rule that is off', async () => {
    await rules({
      site: 'shop',
      rules: [rule('production', 'went_up', ['a@acme.example'], false)],
      by: BY,
    });
    await history('production');
    await release('production', '1.7', since);
    clock = new Date(since + DAY);
    await events('production', since, 100, '1.7');
    expect(await alerts().tick()).toEqual({ sent: 0, failed: 0 });
    expect(mail.sent).toHaveLength(0);
  });
});

describe('the mail', () => {
  it('is plain words with a text part, and escapes what the app sent', () => {
    const m = newKindMail({
      name: 'Shop',
      environment: 'production',
      kind: 'TypeError',
      message: '<script>alert(1)</script>',
      release: null,
      link: null,
    });
    expect(m.subject).toBe('New error in Shop (live)');
    expect(m.html).not.toContain('<script>');
    expect(m.text).toContain('<script>alert(1)</script>');
  });
});
