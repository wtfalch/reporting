import { bigint, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
  actorClass: text('actor_class'),
  actorId: text('actor_id'),
});

export const serviceTables = { siteKeys: reportingSiteKeys, auditEvents };

export type SiteKeyRow = typeof reportingSiteKeys.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
