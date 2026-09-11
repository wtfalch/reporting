import { alertRow } from '../alerts.js';
import { eventInputSchema } from '../schema.js';
import { DEFAULT_SETTINGS, RETENTION_BOUNDS } from '../settings.js';
import type { ReportingEventRow } from '../tables.js';
import { tables } from '../tables.js';
import type {
  Actor,
  AlertFinding,
  EventsPageOptions,
  Logger,
  Reporting,
  Settings,
  SettingsChange,
} from '../types.js';

/**
 * An in-memory `Reporting` for a host's unit tests: same validation, same
 * shape, no database. `rows` is the table; `alerts` is what `onAlert` would
 * have received. Validation failures throw, as in development.
 */
export interface FakeReporting extends Reporting {
  readonly rows: ReportingEventRow[];
  readonly alerts: AlertFinding[];
  reset(): void;
}

const silent: Logger = { info() {}, warn() {}, error() {} };

export function createFakeReporting(opts: { site?: string; log?: Logger } = {}): FakeReporting {
  const site = opts.site ?? 'test';
  const log = opts.log ?? silent;
  const rows: ReportingEventRow[] = [];
  const alerts: AlertFinding[] = [];
  let settings: Settings = { ...DEFAULT_SETTINGS };
  let id = 0;

  const fake: FakeReporting = {
    site,
    log,
    tables,
    rows,
    alerts,
    event(input) {
      const v = eventInputSchema.parse(input);
      id += 1;
      rows.push({
        id,
        occurredAt: v.occurredAt ?? new Date(),
        level: v.level,
        kind: v.kind,
        kindNs: v.kind.split('.')[0] ?? '',
        site,
        tenantId: v.tenantId ?? null,
        actorClass: v.actor?.class ?? null,
        actorId: v.actor?.id ?? null,
        requestId: v.requestId ?? null,
        targetType: v.target?.type ?? null,
        targetId: v.target?.id ?? null,
        message: v.message,
        data: v.data,
        schemaVersion: 1,
      });
    },
    alert(finding) {
      fake.event(alertRow(finding));
      alerts.push(finding);
    },
    async flush() {},
    events: {
      async page(o: EventsPageOptions = {}) {
        const limit = Math.max(1, Math.min(o.limit ?? 50, 200));
        let list = [...rows].sort(
          (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id - a.id,
        );
        if (o.level) list = list.filter((r) => r.level === o.level);
        if (o.kindNs) list = list.filter((r) => r.kindNs === o.kindNs);
        if (o.tenantId) list = list.filter((r) => r.tenantId === o.tenantId);
        if (o.site) list = list.filter((r) => r.site === o.site);
        if (o.requestId) list = list.filter((r) => r.requestId === o.requestId);
        if (o.after) {
          const { occurredAt, id: afterId } = o.after;
          list = list.filter(
            (r) =>
              r.occurredAt.getTime() < occurredAt.getTime() ||
              (r.occurredAt.getTime() === occurredAt.getTime() && r.id < afterId),
          );
        }
        const items = list.slice(0, limit);
        const last = items.at(-1);
        return {
          items,
          next: list.length > limit && last ? { occurredAt: last.occurredAt, id: last.id } : null,
        };
      },
    },
    settings: {
      async get() {
        return settings;
      },
      async set(patch: Partial<Settings>, by: Actor): Promise<SettingsChange> {
        const before = settings;
        for (const [key, value] of Object.entries(patch)) {
          if (
            typeof value !== 'number' ||
            !Number.isInteger(value) ||
            value < RETENTION_BOUNDS.min ||
            value > RETENTION_BOUNDS.max
          ) {
            throw new Error(`reporting.settings: ${key} out of bounds`);
          }
        }
        settings = { ...settings, ...patch };
        const changed = Object.keys(patch).filter(
          (k) => before[k as keyof Settings] !== settings[k as keyof Settings],
        );
        return { before, after: settings, by, changed };
      },
    },
    stats: () => ({ queued: 0, dropped: 0, invalid: 0, flushed: rows.length }),
    reset() {
      rows.length = 0;
      alerts.length = 0;
      settings = { ...DEFAULT_SETTINGS };
      id = 0;
    },
  };
  return fake;
}
