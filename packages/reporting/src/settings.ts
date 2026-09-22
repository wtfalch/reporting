import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { reportingSettings, reportingTenantSettings } from './tables.js';
import type { Actor, Db, Settings, SettingsChange } from './types.js';

/**
 * Operator-edited settings, one row per key, read by housekeeping on every
 * run. Bounds are enforced here and again inside `reporting_prune_events`,
 * whose clamp is what makes a setting safe to expose: the worst an edit can
 * do is shorten history to a week.
 */

export const RETENTION_BOUNDS = { min: 7, max: 400 } as const;
export const CONSENT_MODES = ['none', 'consented', 'always'] as const;
const retention = z.number().int().min(RETENTION_BOUNDS.min).max(RETENTION_BOUNDS.max);

const DEFS: { [K in keyof Settings]: { schema: z.ZodType<Settings[K]>; default: Settings[K] } } = {
  'events.retention_days': { schema: retention, default: 30 },
  // Ninety, not thirty: behaviour is watched over years through the rollups,
  // and a dimension they lack is a recompute over this window (D13).
  'analytics.retention_days': { schema: retention, default: 90 },
  // Cookieless until the person says otherwise (D15).
  'analytics.consent': { schema: z.enum(CONSENT_MODES), default: 'consented' },
  // A signed-in person's rows carry their id, as the product's own record of
  // serving them; one line to change if advice changes (D15).
  'analytics.identify_signed_in': { schema: z.boolean(), default: true },
};

export const DEFAULT_SETTINGS: Settings = Object.freeze(
  Object.fromEntries(Object.entries(DEFS).map(([k, d]) => [k, d.default])) as unknown as Settings,
);

function fromRows(rows: { key: string; value: unknown }[]): Settings {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    const def = DEFS[row.key as keyof Settings];
    if (!def) continue;
    const parsed = (def.schema as z.ZodType<unknown>).safeParse(row.value);
    if (parsed.success) out[row.key] = parsed.data;
  }
  return out as unknown as Settings;
}

export async function getSettings(db: Db): Promise<Settings> {
  const rows = await db
    .select({ key: reportingSettings.key, value: reportingSettings.value })
    .from(reportingSettings);
  return fromRows(rows);
}

/** Validates every key, writes the changed ones in one transaction, returns before and after. Throws on an out-of-bounds value: the caller is a form. */
export async function setSettings(
  db: Db,
  patch: Partial<Settings>,
  by: Actor,
): Promise<SettingsChange> {
  const entries = Object.entries(patch) as [keyof Settings, unknown][];
  for (const [key, value] of entries) {
    const def = DEFS[key];
    if (!def) throw new Error(`reporting.settings: unknown key "${key}"`);
    const parsed = (def.schema as z.ZodType<unknown>).safeParse(value);
    if (!parsed.success) {
      throw new Error(
        key.endsWith('retention_days')
          ? `reporting.settings: ${key} must be an integer between ${RETENTION_BOUNDS.min} and ${RETENTION_BOUNDS.max}`
          : `reporting.settings: ${key} is not a valid value`,
      );
    }
  }
  return db.transaction(async (tx) => {
    const before = fromRows(
      await tx
        .select({ key: reportingSettings.key, value: reportingSettings.value })
        .from(reportingSettings),
    );
    const changed: string[] = [];
    for (const [key, value] of entries) {
      if (before[key] === value) continue;
      changed.push(key);
      await tx
        .insert(reportingSettings)
        .values({ key, value, updatedBy: `${by.class}:${by.id}` })
        .onConflictDoUpdate({
          target: reportingSettings.key,
          set: { value, updatedAt: sql`now()`, updatedBy: `${by.class}:${by.id}` },
        });
    }
    const after = { ...before, ...Object.fromEntries(entries) } as Settings;
    return { before, after, by, changed };
  });
}

/**
 * A multi-tenant company app may need a longer or shorter retention window
 * for one customer's contract without moving the site-wide default (gap
 * issue #11): `reporting_tenant_settings`, keyed by (tenant_id, key), one
 * JSONB value the same shape `getSettings`/`setSettings` already parse.
 * `reporting_prune_events`/`reporting_prune_analytics` (0004_tenant_settings.sql)
 * check this table for the row they are about to prune before falling back
 * to the site-wide setting.
 */
export const TENANT_RETENTION_KEYS = ['events.retention_days', 'analytics.retention_days'] as const;
export type TenantRetentionKey = (typeof TENANT_RETENTION_KEYS)[number];

/** Only the keys this tenant has overridden; a key absent here means "use the site-wide default". */
export async function getTenantRetention(
  db: Db,
  tenantId: string,
): Promise<Partial<Record<TenantRetentionKey, number>>> {
  const rows = await db
    .select({ key: reportingTenantSettings.key, value: reportingTenantSettings.value })
    .from(reportingTenantSettings)
    .where(eq(reportingTenantSettings.tenantId, tenantId));
  const out: Partial<Record<TenantRetentionKey, number>> = {};
  for (const row of rows) {
    if (typeof row.value === 'number' && Number.isInteger(row.value)) {
      out[row.key as TenantRetentionKey] = row.value;
    }
  }
  return out;
}

/**
 * Sets a tenant's override, or clears it back to the site-wide default when
 * `days` is `null` -- clearing never deletes the row, same "nothing that
 * deletes" convention as `reportingSettings`: it stores the JSON `null`
 * `reporting_prune_events`/`reporting_prune_analytics` already treat as "no
 * override". Throws on an out-of-bounds value: the caller is a form.
 */
export async function setTenantRetention(
  db: Db,
  tenantId: string,
  key: TenantRetentionKey,
  days: number | null,
  by: Actor,
): Promise<void> {
  if (days !== null) {
    const parsed = retention.safeParse(days);
    if (!parsed.success) {
      throw new Error(
        `reporting.tenantSettings: ${key} must be an integer between ${RETENTION_BOUNDS.min} and ${RETENTION_BOUNDS.max}`,
      );
    }
  }
  // The column is `jsonb not null`, and a JS `null` value maps to a SQL
  // NULL parameter, not the JSON literal `null` -- an explicit cast is the
  // only way to store "no override" as the value the CHECK and the prune
  // functions both expect, rather than violate the NOT NULL constraint.
  const value = days === null ? sql`'null'::jsonb` : sql`to_jsonb(${days}::int)`;
  await db
    .insert(reportingTenantSettings)
    .values({ tenantId, key, value, updatedBy: `${by.class}:${by.id}` })
    .onConflictDoUpdate({
      target: [reportingTenantSettings.tenantId, reportingTenantSettings.key],
      set: { value, updatedAt: sql`now()`, updatedBy: `${by.class}:${by.id}` },
    });
}
