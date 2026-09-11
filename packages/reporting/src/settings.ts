import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { reportingSettings } from './tables.js';
import type { Actor, Db, Settings, SettingsChange } from './types.js';

/**
 * Operator-edited settings, one row per key, read by housekeeping on every
 * run. Bounds are enforced here and again inside `reporting_prune_events`,
 * whose clamp is what makes a setting safe to expose: the worst an edit can
 * do is shorten history to a week.
 */

export const RETENTION_BOUNDS = { min: 7, max: 400 } as const;

const DEFS = {
  'events.retention_days': {
    schema: z.number().int().min(RETENTION_BOUNDS.min).max(RETENTION_BOUNDS.max),
    default: 30,
  },
} as const satisfies Record<keyof Settings, { schema: z.ZodType<number>; default: number }>;

export const SETTING_KEYS = Object.keys(DEFS) as (keyof Settings)[];

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  'events.retention_days': DEFS['events.retention_days'].default,
});

function fromRows(rows: { key: string; value: unknown }[]): Settings {
  const out: Record<string, number> = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    const def = DEFS[row.key as keyof Settings];
    if (!def) continue;
    const parsed = def.schema.safeParse(row.value);
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
    const parsed = def.schema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `reporting.settings: ${key} must be an integer between ${RETENTION_BOUNDS.min} and ${RETENTION_BOUNDS.max}`,
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
