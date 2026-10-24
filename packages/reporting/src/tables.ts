import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
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
    environment: text('environment'),
    release: text('release'),
    color: text('color'),
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

/** A tenant's own override of a retention setting; mirrored from migrations/0006_tenant_settings.sql. */
export const reportingTenantSettings = pgTable(
  'reporting_tenant_settings',
  {
    tenantId: uuid('tenant_id').notNull(),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
    updatedBy: text('updated_by'),
  },
  (t) => [
    primaryKey({
      name: 'reporting_tenant_settings_pkey',
      columns: [t.tenantId, t.key],
    }),
  ],
);

/** One row per fingerprint; mirrored from migrations/0003_errors.sql. */
export const reportingErrors = pgTable(
  'reporting_errors',
  {
    fingerprint: text('fingerprint').primaryKey(),
    site: text('site').notNull(),
    environment: text('environment'),
    kind: text('kind').notNull(),
    message: text('message').notNull(),
    stack: text('stack'),
    runtime: text('runtime').notNull(),
    release: text('release'),
    color: text('color'),
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

/** One row per (fingerprint, tenant): that tenant's own occurrences of a shared error group; mirrored from migrations/0008_error_tenants.sql. */
export const reportingErrorTenants = pgTable(
  'reporting_error_tenants',
  {
    fingerprint: text('fingerprint').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    occurrences: bigint('occurrences', { mode: 'number' }).notNull().default(1),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'reporting_error_tenants_pkey', columns: [t.fingerprint, t.tenantId] }),
    index('reporting_error_tenants_tenant_idx').on(t.tenantId, t.lastSeenAt.desc()),
  ],
);

export type ReportingEventRow = typeof reportingEvents.$inferSelect;
export type ReportingTaskRow = typeof reportingTasks.$inferSelect;
export type ReportingSettingRow = typeof reportingSettings.$inferSelect;
export type ReportingTenantSettingRow = typeof reportingTenantSettings.$inferSelect;
export type ReportingErrorRow = typeof reportingErrors.$inferSelect;

/**
 * A group as a tenant sees it: the shared group's text and request facts come
 * from whichever tenant hit it last, and its triage state (`state`,
 * `resolvedAt`) is one operator's call for all tenants, so they are null here.
 * Counts, times and
 * `tenantId` are the tenant's own (reporting_error_tenants).
 */
export type TenantErrorRow = Omit<
  ReportingErrorRow,
  | 'message'
  | 'stack'
  | 'runtime'
  | 'release'
  | 'color'
  | 'requestId'
  | 'resolvedBy'
  | 'state'
  | 'resolvedAt'
> & {
  readonly message: null;
  readonly stack: null;
  readonly runtime: null;
  readonly release: null;
  readonly color: null;
  readonly requestId: null;
  readonly resolvedBy: null;
  /** Triage state is shared across tenants, so a tenant cannot see it. */
  readonly state: null;
  readonly resolvedAt: null;
};

/** Request, 5xx, slow, duration and sign-in counts per minute, color and release; mirrored from migrations/0010_requests.sql and 0011_request_timings.sql. */
export const reportingRequests = pgTable(
  'reporting_requests',
  {
    bucket: timestamp('bucket', { withTimezone: true }).notNull(),
    site: text('site').notNull(),
    color: text('color').notNull().default(''),
    release: text('release').notNull().default(''),
    requests: bigint('requests', { mode: 'number' }).notNull().default(0),
    errors: bigint('errors', { mode: 'number' }).notNull().default(0),
    durationMsSum: bigint('duration_ms_sum', { mode: 'number' }).notNull().default(0),
    slow: bigint('slow', { mode: 'number' }).notNull().default(0),
    signIns: bigint('sign_ins', { mode: 'number' }).notNull().default(0),
    signInFailures: bigint('sign_in_failures', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    primaryKey({
      name: 'reporting_requests_pkey',
      columns: [t.bucket, t.site, t.color, t.release],
    }),
  ],
);

export const tables = {
  events: reportingEvents,
  tasks: reportingTasks,
  settings: reportingSettings,
  tenantSettings: reportingTenantSettings,
  errors: reportingErrors,
  errorTenants: reportingErrorTenants,
  requests: reportingRequests,
};
