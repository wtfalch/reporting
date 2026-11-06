import { type Transport, layout, mailButton, mailHeading, mailText } from '@wtfalch/mailer';
import { type Actor, type Db, actorSchema, reportingErrors } from '@wtfalch/reporting-core';
import { reportingEvents } from '@wtfalch/reporting-core';
import { and, asc, desc, eq, gte, like, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit } from './audit.js';
import { type Logger, errorName } from './log.js';
import { errorSeries } from './reads.js';
import { ENVIRONMENTS, INGEST_LIMITS, type ReportingEnvironment, SITE_PATTERN } from './schema.js';
import { reportingAlertRules, reportingAlerts, reportingReleases } from './tables.js';

/**
 * Error emails (wtfalch/reporting#102): a company chooses, per site and
 * environment, to be mailed when a new kind of error appears (`new_kind`) and
 * when errors go up after a release (`went_up`). Boule writes the choices
 * (Errors › Settings, board r1-gc-err-set) with the operator key; this
 * backend decides and sends, through the company's own mail.
 *
 * One mail per new kind and one per release: every mail is first claimed as a
 * row of `reporting_alerts`, unique per site, environment, kind and subject
 * (the group's fingerprint, or the release), so a second tick, a second host
 * or a retry can never decide it again. A send that fails is logged as fixed
 * text and tried again at most `ALERT_LIMITS.attempts` times in all, each at
 * least `ALERT_LIMITS.retryAfterMs` apart, and then left.
 */

export const ALERT_KINDS = ['new_kind', 'went_up'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_LIMITS = {
  /** Recipients a rule may name. */
  recipients: 20,
  /** Tries per mail, the first included. */
  attempts: 3,
  /** The least time between two tries of one mail. */
  retryAfterMs: 10 * 60_000,
  /** A claim older than this with no answer is a crashed send, tried again. */
  staleSendingMs: 15 * 60_000,
  /** One send to one recipient is cut off after this; the mail is then failed and retried. */
  sendTimeoutMs: 15_000,
  /** A group first seen longer ago than this is not news, whatever the rule. */
  newKindLookbackMs: 24 * 60 * 60_000,
  /** New kinds mailed per rule per tick; the rest wait for the next tick. */
  newKindsPerTick: 10,
  /** A release older than this is not checked for a rise any more. */
  riseWindowMs: 7 * 24 * 60 * 60_000,
} as const;

// ---------------------------------------------------------------------------
// "Went up": the same rule as Boule's W5.2 (`baselineAfter` in boule
// src/lib/apps/errors/service.ts, #583). Change both together.

/** Raised: the rate since a release is at least this many times the normal rate, and... */
export const RAISED_FACTOR = 3;
/** ...at least this many errors have come since. With a normal of 0 only this applies. */
export const RAISED_MIN = 10;
/** Normal is the median of this many whole UTC days before the release day... */
export const BASELINE_DAYS = 8;
/** ...counting from the first day with an error; fewer days than this and nothing is raised. */
export const BASELINE_MIN_DAYS = 3;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface Baseline {
  /** Errors since the release went up. */
  readonly sinceRelease: number;
  /** The median errors a day before the release; `null` with too little history. */
  readonly normalPerDay: number | null;
  readonly raised: boolean;
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

/**
 * Did errors go up after a release? `daily` is the errors per whole UTC day in
 * the `BASELINE_DAYS` before the release day, oldest first, zeros included. A
 * day is history from the first day with an error on; a window with no error
 * at all counts every day. Fewer than `BASELINE_MIN_DAYS` days: normal is null
 * and nothing is raised. Hours since the release count as at least one.
 */
export function baselineOf(input: {
  readonly sinceMs: number;
  readonly nowMs: number;
  readonly daily: readonly number[];
  readonly sinceRelease: number;
}): Baseline {
  const first = input.daily.findIndex((n) => n > 0);
  const history = first === -1 ? input.daily : input.daily.slice(first);
  const normalPerDay = history.length >= BASELINE_MIN_DAYS ? median(history) : null;
  const hours = Math.max((input.nowMs - input.sinceMs) / HOUR, 1);
  const raised =
    normalPerDay !== null &&
    input.sinceRelease >= RAISED_MIN &&
    (normalPerDay === 0 || (input.sinceRelease / hours) * 24 >= RAISED_FACTOR * normalPerDay);
  return { sinceRelease: input.sinceRelease, normalPerDay, raised };
}

/** The baseline of one release on one site and environment, read from `reporting_events`. */
export async function baselineAfter(
  db: Db,
  where: { site: string; environment: ReportingEnvironment },
  since: Date,
  now: Date,
): Promise<Baseline> {
  const sinceMs = since.getTime();
  const dayStart = Math.floor(sinceMs / DAY) * DAY;
  const before = await errorSeries(db, {
    ...where,
    from: new Date(dayStart - BASELINE_DAYS * DAY),
    to: new Date(dayStart),
    bucketMinutes: 1440,
  });
  let sinceRelease = 0;
  if (now.getTime() > sinceMs) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
      .from(reportingEvents)
      .where(
        and(
          eq(reportingEvents.level, 'error'),
          like(reportingEvents.kind, 'error.%'),
          eq(reportingEvents.site, where.site),
          eq(reportingEvents.environment, where.environment),
          gte(reportingEvents.occurredAt, since),
          lt(reportingEvents.occurredAt, now),
        ),
      );
    sinceRelease = row?.n ?? 0;
  }
  return baselineOf({
    sinceMs,
    nowMs: now.getTime(),
    daily: before.buckets.map((b) => b.errors),
    sinceRelease,
  });
}

// ---------------------------------------------------------------------------
// The rules, as the operator reads and writes them: Boule's four switches
// (Errors › Settings, `AlertChoices` in boule src/lib/apps/errors/alerts.ts),
// per copy (`live` is the `production` environment, `work` the `stage` one)
// and per email, plus who gets them.

/** Boule's names for a site's two copies, and the environment each one writes as. */
export const ALERT_COPIES = { live: 'production', work: 'stage' } as const;
export type AlertCopy = keyof typeof ALERT_COPIES;
const COPIES = Object.keys(ALERT_COPIES) as AlertCopy[];

/** One copy's two switches, as Boule keeps them. */
export interface AlertChoice {
  /** Email when a new kind of error appears in this copy: once per kind, the first time. */
  readonly newKind: boolean;
  /** Email when errors go up after a release in this copy: once per release. */
  readonly wentUp: boolean;
}
export type AlertChoices = Readonly<Record<AlertCopy, AlertChoice>>;

const KIND_OF: Record<keyof AlertChoice, AlertKind> = { newKind: 'new_kind', wentUp: 'went_up' };
const SWITCHES = Object.keys(KIND_OF) as (keyof AlertChoice)[];

/** What `GET /v1/alert-rules?site` answers and `PUT /v1/alert-rules` answers back. */
export interface AlertRules {
  readonly site: string;
  /** What the mail calls the site; `null` uses the site. */
  readonly name: string | null;
  /** Who gets every email of this site. */
  readonly recipients: readonly string[];
  /** Where a mail's button goes, per copy (the copy's Errors page in Boule); `null` for no button. */
  readonly links: Readonly<Record<AlertCopy, string | null>>;
  /** All four switches; a site never saved has them all off. */
  readonly choices: AlertChoices;
  readonly updatedAt: string | null;
}

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const email = z.string().trim().toLowerCase().max(254).regex(EMAIL, 'not an email address');
const link = z
  .string()
  .max(2048)
  .regex(/^https:\/\/[^\s]+$/)
  .nullish();
const choice = z.strictObject({ newKind: z.boolean(), wentUp: z.boolean() });

/** `PUT /v1/alert-rules`: the whole of a site's choices at once, as Boule saves them. */
export const alertRulesBodySchema = z
  .strictObject({
    site: z.string().regex(SITE_PATTERN),
    name: z.string().trim().min(1).max(100).nullish(),
    recipients: z.array(email).max(ALERT_LIMITS.recipients),
    links: z.strictObject({ live: link, work: link }).optional(),
    choices: z.strictObject({ live: choice, work: choice }),
    by: actorSchema,
  })
  .refine(
    (b) =>
      b.recipients.length > 0 || COPIES.every((c) => !b.choices[c].newKind && !b.choices[c].wentUp),
    { message: 'an email that is on needs at least one recipient' },
  );
export type AlertRulesInput = z.infer<typeof alertRulesBodySchema>;

/** `POST /v1/releases`: when a site's environment started running a release. */
export const releaseBodySchema = z.strictObject({
  site: z.string().regex(SITE_PATTERN),
  environment: z.enum(ENVIRONMENTS),
  release: z.string().min(1).max(INGEST_LIMITS.release),
  since: z.iso.datetime({ offset: true }),
});
export type ReleaseInput = z.infer<typeof releaseBodySchema>;

export async function readAlertRules(db: Db, site: string): Promise<AlertRules> {
  const rows = await db
    .select()
    .from(reportingAlertRules)
    .where(eq(reportingAlertRules.site, site));
  const held = new Map(rows.map((r) => [`${r.environment}/${r.kind}`, r]));
  const on = (copy: AlertCopy, s: keyof AlertChoice) =>
    held.get(`${ALERT_COPIES[copy]}/${KIND_OF[s]}`)?.enabled ?? false;
  const linkOf = (copy: AlertCopy) =>
    rows.find((r) => r.environment === ALERT_COPIES[copy] && r.link)?.link ?? null;
  const newest = rows.reduce<Date | null>(
    (at, r) => (at && at >= new Date(r.updatedAt) ? at : new Date(r.updatedAt)),
    null,
  );
  return {
    site,
    name: rows.find((r) => r.siteName)?.siteName ?? null,
    recipients: rows[0]?.recipients ?? [],
    links: { live: linkOf('live'), work: linkOf('work') },
    choices: {
      live: { newKind: on('live', 'newKind'), wentUp: on('live', 'wentUp') },
      work: { newKind: on('work', 'newKind'), wentUp: on('work', 'wentUp') },
    },
    updatedAt: newest ? newest.toISOString() : null,
  };
}

/**
 * Saves all four rules of a site and the audit row in one transaction. A rule
 * turned on from off starts its `enabled_since` now, so groups first seen
 * before it are not mailed as new; one that stays on keeps it. `name` and
 * `links` left out keep what is held.
 */
export async function saveAlertRules(
  db: Db,
  tenantId: string,
  input: AlertRulesInput,
  now: Date,
): Promise<AlertRules> {
  await db.transaction(async (tx) => {
    const current = await tx
      .select()
      .from(reportingAlertRules)
      .where(eq(reportingAlertRules.site, input.site));
    const held = new Map(current.map((r) => [`${r.environment}/${r.kind}`, r]));
    const recipients = [...new Set(input.recipients)];
    for (const copy of COPIES) {
      const environment = ALERT_COPIES[copy];
      for (const s of SWITCHES) {
        const kind = KIND_OF[s];
        const was = held.get(`${environment}/${kind}`);
        const enabled = input.choices[copy][s];
        const values = {
          enabled,
          recipients,
          link: input.links ? (input.links[copy] ?? null) : (was?.link ?? null),
          siteName: input.name !== undefined ? input.name : (was?.siteName ?? null),
          enabledSince: enabled ? (was?.enabled ? was.enabledSince : now) : null,
          tenantId,
          updatedAt: now,
          updatedByClass: input.by.class,
          updatedById: input.by.id,
        };
        await tx
          .insert(reportingAlertRules)
          .values({ site: input.site, environment, kind, ...values })
          .onConflictDoUpdate({
            target: [
              reportingAlertRules.site,
              reportingAlertRules.environment,
              reportingAlertRules.kind,
            ],
            set: values,
          });
      }
    }
    await writeAudit(tx, tenantId, { operation: 'alert_rule.set', site: input.site, by: input.by });
  });
  return readAlertRules(db, input.site);
}

/**
 * Records when a release went up; a repeat of the same release moves its time.
 * The audit row commits with the write, so a failed write leaves none.
 */
export async function recordRelease(
  db: Db,
  tenantId: string | null,
  input: ReleaseInput,
  now: Date,
): Promise<void> {
  const since = new Date(input.since);
  await db.transaction(async (tx) => {
    await tx
      .insert(reportingReleases)
      .values({ ...input, since, updatedAt: now })
      .onConflictDoUpdate({
        target: [reportingReleases.site, reportingReleases.environment, reportingReleases.release],
        set: { since, updatedAt: now },
      });
    await writeAudit(tx, tenantId, {
      operation: 'release.recorded',
      site: input.site,
      environment: input.environment,
      release: input.release,
    });
  });
}

/**
 * The release a site's environment runs now and when it went up: the newest
 * the operator recorded; with none, the release of the newest error that names
 * one, counted from its first error (an approximation until Boule records its
 * releases: it starts the clock late, so a rise can read higher than Boule's).
 */
export async function currentRelease(
  db: Db,
  where: { site: string; environment: ReportingEnvironment },
): Promise<{ release: string; since: Date } | null> {
  const [recorded] = await db
    .select({ release: reportingReleases.release, since: reportingReleases.since })
    .from(reportingReleases)
    .where(
      and(
        eq(reportingReleases.site, where.site),
        eq(reportingReleases.environment, where.environment),
      ),
    )
    .orderBy(desc(reportingReleases.since))
    .limit(1);
  if (recorded) return { release: recorded.release, since: new Date(recorded.since) };
  const errorEvents = and(
    eq(reportingEvents.level, 'error'),
    like(reportingEvents.kind, 'error.%'),
    eq(reportingEvents.site, where.site),
    eq(reportingEvents.environment, where.environment),
  );
  const [newest] = await db
    .select({ release: reportingEvents.release })
    .from(reportingEvents)
    .where(and(errorEvents, sql`${reportingEvents.release} is not null`))
    .orderBy(desc(reportingEvents.occurredAt))
    .limit(1);
  if (!newest?.release) return null;
  const [first] = await db
    .select({ at: sql<string>`min(${reportingEvents.occurredAt})` })
    .from(reportingEvents)
    .where(and(errorEvents, eq(reportingEvents.release, newest.release)));
  return first?.at ? { release: newest.release, since: new Date(first.at) } : null;
}

// ---------------------------------------------------------------------------
// The mails.

/** How the host sends: the company's mail transport and its From line. */
export interface AlertMail {
  readonly transport: Transport;
  /** `MAIL_FROM` as foundry delivers it: an address, or `Name <address>`. */
  readonly from: string;
}

const COPY_WORD: Record<ReportingEnvironment, string> = {
  production: 'live',
  stage: 'workspace',
};

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The words of a mail are plain, for people who do not write code. */
export function newKindMail(input: {
  readonly name: string;
  readonly environment: ReportingEnvironment;
  readonly kind: string;
  readonly message: string;
  readonly release: string | null;
  readonly link: string | null;
}) {
  const where = `${input.name} (${COPY_WORD[input.environment]})`;
  const what = cut(input.kind ? `${input.kind}: ${input.message}` : input.message, 300);
  const lines = [
    `${where} had an error it has not had before.`,
    what,
    ...(input.release ? [`It came from release ${input.release}.`] : []),
  ];
  return layout({
    subject: cut(`New error in ${where}`, 150),
    bodyHtml: [
      mailHeading('A new kind of error'),
      ...lines.map((line) => mailText(line)),
      ...(input.link ? [mailButton(input.link, 'See the errors')] : []),
    ].join(''),
    bodyText: [...lines, ...(input.link ? [`See the errors: ${input.link}`] : [])].join('\n\n'),
    brand: { name: input.name },
    footnote: `You get this because ${where} is set to email you when a new kind of error appears. You can change it in Errors, Settings.`,
  });
}

export function wentUpMail(input: {
  readonly name: string;
  readonly environment: ReportingEnvironment;
  readonly release: string;
  readonly baseline: Baseline;
  readonly link: string | null;
}) {
  const where = `${input.name} (${COPY_WORD[input.environment]})`;
  const n = input.baseline.sinceRelease;
  const normal = input.baseline.normalPerDay;
  const lines = [
    `${where} has had ${n} ${n === 1 ? 'error' : 'errors'} since release ${input.release} went up.`,
    normal === 0 || normal === null
      ? 'Before that release, a normal day had none.'
      : `Before that release, a normal day had ${Math.round(normal * 10) / 10}.`,
  ];
  return layout({
    subject: cut(`Errors went up after release ${input.release} of ${where}`, 150),
    bodyHtml: [
      mailHeading('Errors went up after a release'),
      ...lines.map((line) => mailText(line)),
      ...(input.link ? [mailButton(input.link, 'See the errors')] : []),
    ].join(''),
    bodyText: [...lines, ...(input.link ? [`See the errors: ${input.link}`] : [])].join('\n\n'),
    brand: { name: input.name },
    footnote: `You get this because ${where} is set to email you when errors go up after a release. You can change it in Errors, Settings.`,
  });
}

// ---------------------------------------------------------------------------
// The tick.

export interface CreateAlertsOptions {
  readonly db: Db;
  /** `null` when the host has no mail: the tick then sends nothing and claims nothing. */
  readonly mail: AlertMail | null;
  readonly log: Logger;
  readonly now?: () => Date;
  /** The least time between two ticks of this process. Default one minute. */
  readonly everyMs?: number;
  /** The longest one send may take. Default `ALERT_LIMITS.sendTimeoutMs`. */
  readonly sendTimeoutMs?: number;
}

export interface AlertTickResult {
  /** Mails claimed and sent to every recipient in this tick, first tries and retries. */
  readonly sent: number;
  /** Mails with at least one recipient that did not take it. */
  readonly failed: number;
  /** Why nothing ran: another tick is running, the last one was too recent, or there is no mail. */
  readonly skipped?: 'running' | 'recent' | 'no-mail';
}

export interface Alerts {
  /** Never throws: a failure is one fixed log line. */
  tick(): Promise<AlertTickResult>;
}

type RuleRow = typeof reportingAlertRules.$inferSelect;
type AlertRowT = typeof reportingAlerts.$inferSelect;

/** The promise's answer, or a `SendTimeoutError` after `ms`: one hung send must not hold the tick. */
function sendWithin<T>(send: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('send timed out');
      error.name = 'SendTimeoutError';
      reject(error);
    }, ms);
  });
  return Promise.race([send, timeout]).finally(() => clearTimeout(timer));
}

export function createAlerts(options: CreateAlertsOptions): Alerts {
  const { db, mail, log } = options;
  const now = options.now ?? (() => new Date());
  const everyMs = options.everyMs ?? 60_000;
  const sendTimeoutMs = options.sendTimeoutMs ?? ALERT_LIMITS.sendTimeoutMs;
  let running: Promise<AlertTickResult> | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;
  let warnedNoMail = false;

  /** One try at every recipient not yet delivered; the row records the outcome. */
  async function deliver(
    row: AlertRowT,
    message: { subject: string; html: string; text: string },
  ): Promise<boolean> {
    if (!mail) return false;
    const delivered = new Set(row.delivered);
    for (const to of row.recipients) {
      if (delivered.has(to)) continue;
      try {
        await sendWithin(mail.transport.send({ ...message, to, from: mail.from }), sendTimeoutMs);
        delivered.add(to);
      } catch (error) {
        // Fixed text and names only: never the address, the mail or the provider's answer.
        log.warn(
          { err: errorName(error), kind: row.kind, site: row.site, environment: row.environment },
          'reporting: alert mail failed',
        );
      }
    }
    const all = row.recipients.every((to) => delivered.has(to));
    await db
      .update(reportingAlerts)
      .set({ delivered: [...delivered], status: all ? 'sent' : 'failed' })
      .where(eq(reportingAlerts.id, row.id));
    return all;
  }

  /** Claims a mail never decided before; `null` when another tick has it. */
  async function claim(rule: RuleRow, subject: string, at: Date): Promise<AlertRowT | null> {
    const [row] = await db
      .insert(reportingAlerts)
      .values({
        site: rule.site,
        environment: rule.environment,
        kind: rule.kind,
        subject,
        recipients: rule.recipients,
        status: 'sending',
        attempts: 1,
        createdAt: at,
        attemptedAt: at,
      })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  }

  async function messageFor(
    rule: RuleRow,
    row: Pick<AlertRowT, 'kind' | 'subject'>,
    at: Date,
  ): Promise<{ subject: string; html: string; text: string } | null> {
    const environment = rule.environment as ReportingEnvironment;
    const name = rule.siteName ?? rule.site;
    if (row.kind === 'new_kind') {
      const [group] = await db
        .select()
        .from(reportingErrors)
        .where(eq(reportingErrors.fingerprint, row.subject))
        .limit(1);
      if (!group) return null;
      return newKindMail({
        name,
        environment,
        kind: group.kind,
        message: group.message,
        release: group.release,
        link: rule.link,
      });
    }
    const release = await db
      .select({ since: reportingReleases.since })
      .from(reportingReleases)
      .where(
        and(
          eq(reportingReleases.site, rule.site),
          eq(reportingReleases.environment, rule.environment),
          eq(reportingReleases.release, row.subject),
        ),
      )
      .limit(1);
    const current = await currentRelease(db, { site: rule.site, environment });
    const since = release[0]?.since ?? (current?.release === row.subject ? current.since : null);
    if (!since) return null;
    const baseline = await baselineAfter(db, { site: rule.site, environment }, new Date(since), at);
    return wentUpMail({ name, environment, release: row.subject, baseline, link: rule.link });
  }

  async function newKinds(rule: RuleRow, at: Date): Promise<AlertRowT[]> {
    if (!rule.enabledSince) return [];
    const from = new Date(
      Math.max(
        new Date(rule.enabledSince).getTime(),
        at.getTime() - ALERT_LIMITS.newKindLookbackMs,
      ),
    );
    const groups = await db
      .select({ fingerprint: reportingErrors.fingerprint })
      .from(reportingErrors)
      .where(
        and(
          eq(reportingErrors.site, rule.site),
          eq(reportingErrors.environment, rule.environment),
          gte(reportingErrors.firstSeenAt, from),
          sql`${reportingErrors.state} <> 'ignored'`,
          sql`not exists (select 1 from reporting_alerts a where a.site = ${rule.site}
            and a.environment = ${rule.environment} and a.kind = 'new_kind'
            and a.subject = ${reportingErrors.fingerprint})`,
        ),
      )
      .orderBy(reportingErrors.firstSeenAt)
      .limit(ALERT_LIMITS.newKindsPerTick);
    const claimed: AlertRowT[] = [];
    for (const g of groups) {
      const row = await claim(rule, g.fingerprint, at);
      if (row) claimed.push(row);
    }
    return claimed;
  }

  async function rise(rule: RuleRow, at: Date): Promise<AlertRowT | null> {
    const environment = rule.environment as ReportingEnvironment;
    const current = await currentRelease(db, { site: rule.site, environment });
    if (!current) return null;
    if (at.getTime() - current.since.getTime() > ALERT_LIMITS.riseWindowMs) return null;
    const [done] = await db
      .select({ id: reportingAlerts.id })
      .from(reportingAlerts)
      .where(
        and(
          eq(reportingAlerts.site, rule.site),
          eq(reportingAlerts.environment, rule.environment),
          eq(reportingAlerts.kind, 'went_up'),
          eq(reportingAlerts.subject, current.release),
        ),
      )
      .limit(1);
    if (done) return null;
    const baseline = await baselineAfter(db, { site: rule.site, environment }, current.since, at);
    if (!baseline.raised) return null;
    return claim(rule, current.release, at);
  }

  /** Failed and crashed sends, taken back one at a time with a compare-and-set. */
  async function retries(rules: Map<string, RuleRow>, at: Date): Promise<AlertRowT[]> {
    const failedBefore = new Date(at.getTime() - ALERT_LIMITS.retryAfterMs);
    const staleBefore = new Date(at.getTime() - ALERT_LIMITS.staleSendingMs);
    // ISO text, not a Date: a raw `sql` parameter is not mapped, and the
    // postgres driver refuses a Date there.
    const due = sql`${reportingAlerts.attempts} < ${ALERT_LIMITS.attempts} and (
      (${reportingAlerts.status} = 'failed' and ${reportingAlerts.attemptedAt} < ${failedBefore.toISOString()}::timestamptz)
      or (${reportingAlerts.status} = 'sending' and ${reportingAlerts.attemptedAt} < ${staleBefore.toISOString()}::timestamptz))`;
    // The oldest attempt first: a mail never tried before comes before one tried lately.
    const rows = await db
      .select()
      .from(reportingAlerts)
      .where(due)
      .orderBy(asc(reportingAlerts.attemptedAt), asc(reportingAlerts.id))
      .limit(20);
    const taken: AlertRowT[] = [];
    for (const row of rows) {
      if (!rules.has(`${row.site}/${row.environment}/${row.kind}`)) {
        // A rule turned off since is not tried again, and must not hold a slot of the queue.
        await db
          .update(reportingAlerts)
          .set({ status: 'dropped' })
          .where(and(eq(reportingAlerts.id, row.id), due));
        log.info(
          { kind: row.kind, site: row.site, environment: row.environment },
          'reporting: alert mail dropped, its rule is off',
        );
        continue;
      }
      const [again] = await db
        .update(reportingAlerts)
        .set({
          status: 'sending',
          attempts: sql`${reportingAlerts.attempts} + 1`,
          attemptedAt: at,
        })
        .where(and(eq(reportingAlerts.id, row.id), due))
        .returning();
      if (again) taken.push(again);
    }
    return taken;
  }

  async function run(): Promise<AlertTickResult> {
    const at = now();
    const enabled = await db
      .select()
      .from(reportingAlertRules)
      .where(eq(reportingAlertRules.enabled, true));
    const rules = new Map(enabled.map((r) => [`${r.site}/${r.environment}/${r.kind}`, r]));
    let sent = 0;
    let failed = 0;
    const send = async (rule: RuleRow, row: AlertRowT) => {
      const message = await messageFor(rule, row, at);
      if (!message) {
        // What the mail was about is gone (a pruned group): nothing to say, never tried again.
        await db
          .update(reportingAlerts)
          .set({ status: 'failed', attempts: ALERT_LIMITS.attempts })
          .where(eq(reportingAlerts.id, row.id));
        failed++;
        return;
      }
      if (await deliver(row, message)) sent++;
      else failed++;
    };
    for (const row of await retries(rules, at)) {
      const rule = rules.get(`${row.site}/${row.environment}/${row.kind}`);
      if (rule) await send(rule, row);
    }
    for (const rule of enabled) {
      const claimed =
        rule.kind === 'new_kind'
          ? await newKinds(rule, at)
          : [await rise(rule, at)].filter((r): r is AlertRowT => r !== null);
      for (const row of claimed) await send(rule, row);
    }
    return { sent, failed };
  }

  return {
    async tick() {
      if (!mail) {
        if (!warnedNoMail) {
          warnedNoMail = true;
          log.warn({}, 'reporting: no mail is set up, so no error emails are sent');
        }
        return { sent: 0, failed: 0, skipped: 'no-mail' };
      }
      if (running) return { sent: 0, failed: 0, skipped: 'running' };
      const at = now().getTime();
      if (at - lastAt < everyMs) return { sent: 0, failed: 0, skipped: 'recent' };
      lastAt = at;
      running = run()
        .catch((error: unknown) => {
          log.error({ err: errorName(error) }, 'reporting: alert tick failed');
          return { sent: 0, failed: 0 };
        })
        .finally(() => {
          running = null;
        });
      return running;
    },
  };
}

export type { Actor };
