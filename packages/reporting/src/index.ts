import { alertRow } from './alerts.js';
import { analyticsRecent, analyticsSeries, analyticsWeekly } from './analytics/reader.js';
import { ANALYTICS_NAME_PATTERN, normalisePath, propsSchema } from './analytics/schema.js';
import { insertAnalytics } from './analytics/write.js';
import { createCapture } from './errors/capture.js';
import { eventsPage } from './reader.js';
import { siteSchema } from './schema.js';
import { getSettings, getTenantRetention, setSettings, setTenantRetention } from './settings.js';
import { tables } from './tables.js';
import type { AlertFinding, Mode, Reporting, ReportingOptions } from './types.js';
import { Writer, describe } from './writer.js';

export * from './schema.js';
export * from './tables.js';
export * from './types.js';
export { alertKind, projectDetail } from './alerts.js';
export { CONSENT_MODES, DEFAULT_SETTINGS, RETENTION_BOUNDS } from './settings.js';
export * from './analytics/schema.js';
export { createCollector, type CollectorOptions, type Sites } from './analytics/collector.js';
export {
  analyticsRecent,
  analyticsSeries,
  analyticsWeekly,
  hideSmallGroups,
  type Grain,
  type RecentEvent,
  type RecentOptions,
  type SeriesOptions,
  type SeriesPoint,
  type WeeklyPoint,
} from './analytics/reader.js';
export type { AnalyticsRow } from './analytics/write.js';

function modeFromEnv(): Mode {
  const env = process.env.NODE_ENV;
  return env === 'development' || env === 'test' ? env : 'production';
}

/**
 * The host's one instance, built once over its drizzle handle and its
 * logger. Framework-neutral: `defer` is how the host says "after this unit of
 * work" (the `./next` entry passes `after()`), and nothing here reads a
 * request, a session or an environment variable other than NODE_ENV.
 */
export function createReporting(options: ReportingOptions): Reporting {
  const site = siteSchema.parse(options.site);
  const now = options.now ?? (() => new Date());
  const mode = options.mode ?? modeFromEnv();
  const defer: (fn: () => Promise<void>) => void =
    options.defer ??
    ((fn) => {
      setTimeout(() => void fn(), 0);
    });
  const writer = new Writer({
    db: options.db,
    log: options.log,
    site,
    mode,
    now,
    defer,
    queueLimit: options.queueLimit ?? 1000,
    batchSize: options.batchSize ?? 500,
    flushEveryMs: options.flushEveryMs ?? 1000,
  });
  // Same db, log, defer, now and site as the writer: one instance, one
  // upsert path, no second connection or timer to keep in sync.
  const capture = createCapture({
    db: options.db,
    log: options.log,
    site,
    now,
    defer,
    event: (input) => writer.event(input),
    release: process.env.REPORTING_RELEASE ?? null,
    redactEnvVars: options.redactEnvVars,
  });

  const reporting: Reporting = {
    site,
    log: options.log,
    tables,
    event: (input) => writer.event(input),
    captureError: (error, context) => capture(error, context),
    alert(finding: AlertFinding) {
      writer.event(alertRow(finding));
      if (!options.onAlert) return;
      try {
        options.onAlert(finding);
      } catch (error) {
        options.log.error({ err: describe(error) }, 'reporting: onAlert threw');
      }
    },
    flush: (opts) => writer.flush(opts),
    events: { page: (opts) => eventsPage(options.db, opts) },
    settings: {
      get: () => getSettings(options.db),
      async set(patch, by) {
        const change = await setSettings(options.db, patch, by);
        if (change.changed.length > 0) {
          writer.event({
            kind: 'reporting.settings_changed',
            message: `settings changed: ${change.changed.join(', ')}`,
            actor: by,
            data: Object.fromEntries(
              change.changed.flatMap((k) => [
                [`${k}.before`, change.before[k as keyof typeof change.before]],
                [`${k}.after`, change.after[k as keyof typeof change.after]],
              ]),
            ),
          });
          if (options.audit) await options.audit(change);
        }
        return change;
      },
    },
    tenantSettings: {
      get: (tenantId) => getTenantRetention(options.db, tenantId),
      set: (tenantId, key, days, by) => setTenantRetention(options.db, tenantId, key, days, by),
    },
    analytics: {
      async track(input) {
        try {
          if (!ANALYTICS_NAME_PATTERN.test(input.name)) {
            throw new Error(`analytics.track: "${input.name}" is not a name`);
          }
          const props = propsSchema.parse(input.props ?? {});
          const at = input.occurredAt ?? now();
          await insertAnalytics(options.db, [
            {
              occurredAt: at,
              receivedAt: now(),
              site,
              tenantId: input.tenantId ?? null,
              visitorId: input.visitorId ?? null,
              sessionId: input.sessionId ?? null,
              userId: input.userId ?? null,
              name: input.name,
              path: (options.normalisePath ?? normalisePath)(input.path ?? '/'),
              referrerHost: null,
              device: input.device ?? 'unknown',
              country: input.country ?? null,
              props,
            },
          ]);
        } catch (error) {
          if (mode !== 'production') throw error;
          options.log.error({ err: describe(error), name: input.name }, 'reporting: track failed');
        }
      },
      series: (opts) => analyticsSeries(options.db, opts),
      weekly: (opts) => analyticsWeekly(options.db, opts),
      recent: (opts) => analyticsRecent(options.db, opts),
    },
    stats: () => writer.stats(),
  };
  return reporting;
}
