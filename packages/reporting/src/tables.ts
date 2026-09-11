import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  jsonb,
  pgTable,
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
    data: jsonb('data').$type<Record<string, string | number | boolean | null>>().notNull(),
    schemaVersion: smallint('schema_version').notNull().default(1),
  },
  (t) => [
    index('reporting_events_time_idx').on(t.occurredAt.desc(), t.id.desc()),
    // The partial predicates live in the SQL; these declare the columns.
    index('reporting_events_tenant_time_idx').on(t.tenantId, t.occurredAt.desc(), t.id.desc()),
    index('reporting_events_ns_time_idx').on(t.kindNs, t.occurredAt.desc(), t.id.desc()),
    index('reporting_events_problem_time_idx').on(t.occurredAt.desc(), t.id.desc()),
    index('reporting_events_request_idx').on(t.requestId, t.occurredAt.desc()),
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
  watermark: text('watermark'),
});

export const reportingSettings = pgTable('reporting_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedBy: text('updated_by'),
});

export type ReportingEventRow = typeof reportingEvents.$inferSelect;
export type ReportingTaskRow = typeof reportingTasks.$inferSelect;
export type ReportingSettingRow = typeof reportingSettings.$inferSelect;

export const tables = {
  events: reportingEvents,
  tasks: reportingTasks,
  settings: reportingSettings,
};
