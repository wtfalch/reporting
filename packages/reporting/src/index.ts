import { alertRow } from './alerts.js';
import { eventsPage } from './reader.js';
import { siteSchema } from './schema.js';
import { getSettings, setSettings } from './settings.js';
import { tables } from './tables.js';
import type { AlertFinding, Mode, Reporting, ReportingOptions } from './types.js';
import { Writer, describe } from './writer.js';

export * from './schema.js';
export * from './tables.js';
export * from './types.js';
export { alertKind, projectDetail } from './alerts.js';
export { DEFAULT_SETTINGS, RETENTION_BOUNDS, SETTING_KEYS } from './settings.js';

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
  const writer = new Writer({
    db: options.db,
    log: options.log,
    site,
    mode,
    now,
    defer:
      options.defer ??
      ((fn) => {
        setTimeout(() => void fn(), 0);
      }),
    queueLimit: options.queueLimit ?? 1000,
    batchSize: options.batchSize ?? 500,
    flushEveryMs: options.flushEveryMs ?? 1000,
  });

  const reporting: Reporting = {
    site,
    db: options.db,
    log: options.log,
    tables,
    event: (input) => writer.event(input),
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
    stats: () => writer.stats(),
  };
  return reporting;
}
