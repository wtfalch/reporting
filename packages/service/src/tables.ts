import {
  bigint,
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** Mirrors `migrations/0001_site_keys.sql`, which is the source of truth. */
export const reportingSiteKeys = pgTable('reporting_site_keys', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  secretHash: text('secret_hash').notNull(),
  site: text('site').notNull(),
  environment: text('environment').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

/** Mirrors `migrations/0002_audit_events.sql`. Append-only: insert and select, nothing else. */
export const auditEvents = pgTable('audit_events', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  operation: text('operation').notNull(),
  tenantId: uuid('tenant_id'),
  site: text('site'),
  keyId: text('key_id'),
  fingerprint: text('fingerprint'),
  state: text('state'),
  environment: text('environment'),
  release: text('release'),
  actorClass: text('actor_class'),
  actorId: text('actor_id'),
});

/** Mirrors `migrations/0003_alerts.sql`: which emails a company wants, per site, environment and kind. */
export const reportingAlertRules = pgTable(
  'reporting_alert_rules',
  {
    site: text('site').notNull(),
    environment: text('environment').notNull(),
    kind: text('kind').notNull(),
    enabled: boolean('enabled').notNull(),
    recipients: text('recipients').array().notNull().default([]),
    siteName: text('site_name'),
    link: text('link'),
    enabledSince: timestamp('enabled_since', { withTimezone: true }),
    tenantId: uuid('tenant_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedByClass: text('updated_by_class'),
    updatedById: text('updated_by_id'),
  },
  (t) => [primaryKey({ columns: [t.site, t.environment, t.kind] })],
);

/** Mirrors `migrations/0003_alerts.sql`: when a release went up, as the operator says. */
export const reportingReleases = pgTable(
  'reporting_releases',
  {
    site: text('site').notNull(),
    environment: text('environment').notNull(),
    release: text('release').notNull(),
    since: timestamp('since', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.site, t.environment, t.release] })],
);

/** Mirrors `migrations/0003_alerts.sql`: one row per mail decided, claimed before it is sent. */
export const reportingAlerts = pgTable('reporting_alerts', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  site: text('site').notNull(),
  environment: text('environment').notNull(),
  kind: text('kind').notNull(),
  subject: text('subject').notNull(),
  recipients: text('recipients').array().notNull(),
  delivered: text('delivered').array().notNull().default([]),
  status: text('status').notNull(),
  attempts: integer('attempts').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }),
});

export const serviceTables = {
  siteKeys: reportingSiteKeys,
  auditEvents,
  alertRules: reportingAlertRules,
  releases: reportingReleases,
  alerts: reportingAlerts,
};

export type SiteKeyRow = typeof reportingSiteKeys.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type AlertRuleRow = typeof reportingAlertRules.$inferSelect;
export type AlertRow = typeof reportingAlerts.$inferSelect;
