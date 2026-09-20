import { sql } from 'drizzle-orm';
import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The three tables, mirrored from `migrations/0001_reporting.sql`, which is
 * the source of truth: the SQL carries the CHECKs, the partial indexes, the
 * generated column and the prune function that drizzle-kit does not
 * generate. A host re-exports these from its own schema module so its
 * drizzle instance and its types know them.
 */

export const reportingEvents = pgTable(
  'reporting_events',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().default(sql`now()`),
    level: text('level').notNull(),
    kind: text('kind').notNull(),
    kindNs: text('kind_ns').generatedAlwaysAs(sql`split_part(kind, '.', 1)`),
    site: text('site').notNull(),
    tenantId: uuid('tenant_id'),
    actorClass: text('actor_class'),
    actorId: text('actor_id'),
    requestId: text('request_id'),
    targetType: text('target_type'),
    targetId: text('target_id'),
    message: text('message').notNull(),
    data: jsonb('data')
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    schemaVersion: smallint('schema_version').notNull().default(1),
  },
  (t) => [
    index('reporting_events_time_idx').on(t.occurredAt.desc(), t.id.desc()),
    index('reporting_events_tenant_time_idx')
      .on(t.tenantId, t.occurredAt.desc(), t.id.desc())
      .where(sql`${t.tenantId} is not null`),
    index('reporting_events_ns_time_idx').on(t.kindNs, t.occurredAt.desc(), t.id.desc()),
    index('reporting_events_problem_time_idx')
      .on(t.occurredAt.desc(), t.id.desc())
      .where(sql`${t.level} in ('error', 'alert')`),
    index('reporting_events_request_idx')
      .on(t.requestId, t.occurredAt.desc())
      .where(sql`${t.requestId} is not null`),
  ],
);

export const reportingTasks = pgTable('reporting_tasks', {
  task: text('task').primaryKey(),
  nextDueAt: timestamp('next_due_at', { withTimezone: true }).notNull().default(sql`now()`),
  lastStartedAt: timestamp('last_started_at', { withTimezone: true }),
  lastFinishedAt: timestamp('last_finished_at', { withTimezone: true }),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  claimToken: uuid('claim_token'),
  lastOutcome: text('last_outcome'),
  lastError: text('last_error'),
  /** The rollups' completed-history watermark (0002), one value per task. */
  watermark: text('watermark'),
});

export const reportingSettings = pgTable('reporting_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedBy: text('updated_by'),
});

/** Raw analytics rows, a window's worth; mirrored from migrations/0002_analytics.sql. */
export const reportingAnalytics = pgTable(
  'reporting_analytics',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().default(sql`now()`),
    site: text('site').notNull(),
    tenantId: uuid('tenant_id'),
    visitorId: text('visitor_id'),
    sessionId: text('session_id'),
    userId: text('user_id'),
    name: text('name').notNull(),
    path: text('path').notNull(),
    referrerHost: text('referrer_host'),
    device: text('device').notNull(),
    country: text('country'),
    props: jsonb('props')
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    schemaVersion: smallint('schema_version').notNull().default(1),
  },
  (t) => [
    index('reporting_analytics_site_time_idx').on(t.site, t.occurredAt.desc(), t.id.desc()),
    index('reporting_analytics_tenant_time_idx')
      .on(t.tenantId, t.occurredAt.desc(), t.id.desc())
      .where(sql`${t.tenantId} is not null`),
    index('reporting_analytics_user_idx').on(t.userId).where(sql`${t.userId} is not null`),
    index('reporting_analytics_site_name_time_idx').on(t.site, t.name, t.occurredAt.desc()),
  ],
);

/** One row per day, site, grain and dimension value; written only by reporting_rollup_day. */
export const reportingAnalyticsDaily = pgTable(
  'reporting_analytics_daily',
  {
    day: date('day').notNull(),
    site: text('site').notNull(),
    grain: text('grain').notNull(),
    tenantId: uuid('tenant_id'),
    name: text('name'),
    path: text('path'),
    device: text('device'),
    country: text('country'),
    referrerHost: text('referrer_host'),
    views: integer('views').notNull(),
    visitors: integer('visitors').notNull(),
    people: integer('people').notNull(),
    tenantKey: text('tenant_key').generatedAlwaysAs(sql`coalesce(tenant_id::text, '')`),
    nameKey: text('name_key').generatedAlwaysAs(sql`coalesce(name, '')`),
    pathKey: text('path_key').generatedAlwaysAs(sql`coalesce(path, '')`),
    deviceKey: text('device_key').generatedAlwaysAs(sql`coalesce(device, '')`),
    countryKey: text('country_key').generatedAlwaysAs(sql`coalesce(country, '')`),
    referrerKey: text('referrer_key').generatedAlwaysAs(sql`coalesce(referrer_host, '')`),
  },
  (t) => [
    primaryKey({
      name: 'reporting_analytics_daily_pkey',
      columns: [
        t.day,
        t.site,
        t.grain,
        t.tenantKey,
        t.nameKey,
        t.pathKey,
        t.deviceKey,
        t.countryKey,
        t.referrerKey,
      ],
    }),
    index('reporting_analytics_daily_site_grain_idx').on(t.site, t.grain, t.day.desc()),
  ],
);

/** Visitors and people per ISO week and how many returned; written only by reporting_rollup_week. */
export const reportingAnalyticsWeekly = pgTable(
  'reporting_analytics_weekly',
  {
    week: date('week').notNull(),
    site: text('site').notNull(),
    tenantId: uuid('tenant_id'),
    visitors: integer('visitors').notNull(),
    returningVisitors: integer('returning_visitors').notNull(),
    people: integer('people').notNull(),
    returningPeople: integer('returning_people').notNull(),
    tenantKey: text('tenant_key').generatedAlwaysAs(sql`coalesce(tenant_id::text, '')`),
  },
  (t) => [
    primaryKey({
      name: 'reporting_analytics_weekly_pkey',
      columns: [t.week, t.site, t.tenantKey],
    }),
  ],
);

/** One row per fingerprint; mirrored from migrations/0003_errors.sql. */
export const reportingErrors = pgTable(
  'reporting_errors',
  {
    fingerprint: text('fingerprint').primaryKey(),
    site: text('site').notNull(),
    kind: text('kind').notNull(),
    message: text('message').notNull(),
    stack: text('stack'),
    runtime: text('runtime').notNull(),
    release: text('release'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    occurrences: bigint('occurrences', { mode: 'number' }).notNull().default(1),
    state: text('state').notNull().default('open'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: text('resolved_by'),
    tenantId: uuid('tenant_id'),
    requestId: text('request_id'),
  },
  (t) => [
    index('reporting_errors_site_open_idx')
      .on(t.site, t.lastSeenAt.desc())
      .where(sql`${t.state} = 'open'`),
    index('reporting_errors_state_idx').on(t.state, t.lastSeenAt.desc()),
  ],
);

export type ReportingEventRow = typeof reportingEvents.$inferSelect;
export type ReportingAnalyticsRow = typeof reportingAnalytics.$inferSelect;
export type ReportingAnalyticsDailyRow = typeof reportingAnalyticsDaily.$inferSelect;
export type ReportingAnalyticsWeeklyRow = typeof reportingAnalyticsWeekly.$inferSelect;
export type ReportingTaskRow = typeof reportingTasks.$inferSelect;
export type ReportingSettingRow = typeof reportingSettings.$inferSelect;
export type ReportingErrorRow = typeof reportingErrors.$inferSelect;

export const tables = {
  events: reportingEvents,
  tasks: reportingTasks,
  settings: reportingSettings,
  analytics: reportingAnalytics,
  analyticsDaily: reportingAnalyticsDaily,
  analyticsWeekly: reportingAnalyticsWeekly,
  errors: reportingErrors,
};
