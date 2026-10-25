import { alertRow } from './alerts.js';
import { createCapture } from './errors/capture.js';
import { eventsPage } from './reader.js';
import { RequestCounter } from './requests.js';
import { environmentSchema, siteSchema } from './schema.js';
import { getSettings, getTenantRetention, setSettings, setTenantRetention } from './settings.js';
import { tables } from './tables.js';
import type { AlertFinding, Mode, Reporting, ReportingOptions } from './types.js';
import { Writer, describe } from './writer.js';

export * from './schema.js';
export * from './tables.js';
export * from './types.js';
export { alertKind, projectDetail } from './alerts.js';
export { countSignIn, SLOW_REQUEST_MS } from './requests.js';
export { DEFAULT_SETTINGS, RETENTION_BOUNDS, TENANT_RETENTION_KEYS } from './settings.js';
export type { TenantRetentionKey } from './settings.js';
// The error-group list, for a host's triage page: filters, keyset paging and
// `search` over message and stack. No permission is applied; the host gates.
export { errorsPage } from './errors/reader.js';
// One error group by fingerprint, and the state move that opens, resolves
// or reopens it -- the two calls a host's triage detail page makes once it
// has a group from errorsPage. No permission is applied; the host gates.
export { errorDetail, setErrorState } from './errors/reader.js';

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
  const environment =
    options.environment != null ? environmentSchema.parse(options.environment) : null;
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
    environment,
    mode,
    now,
    defer,
    queueLimit: options.queueLimit ?? 1000,
    batchSize: options.batchSize ?? 500,
    flushEveryMs: options.flushEveryMs ?? 1000,
  });
  const requests = new RequestCounter({
    db: options.db,
    log: options.log,
    site,
    now,
    flushEveryMs: options.requestFlushEveryMs ?? 10_000,
  });
  // One alerting path, shared by `reporting.alert()` and a new-or-reopened
  // capture (errors/capture.ts's `alert` option): an `alert.<check>` row,
  // already indexed and pruned the same as everything else on the
  // timeline, then the host's own hook -- never a vendor's. A throw from
  // that hook is the host's, not this package's, to fail on.
  function fireAlert(finding: AlertFinding): void {
    writer.event(alertRow(finding));
    if (!options.onAlert) return;
    try {
      options.onAlert(finding);
    } catch (error) {
      options.log.error({ err: describe(error) }, 'reporting: onAlert threw');
    }
  }
  // Same db, log, defer, now and site as the writer: one instance, one
  // upsert path, no second connection or timer to keep in sync.
  const capture = createCapture({
    db: options.db,
    log: options.log,
    site,
    environment,
    now,
    defer,
    event: (input) => writer.event(input),
    release: process.env.REPORTING_RELEASE ?? null,
    alert: fireAlert,
    redactEnvVars: options.redactEnvVars,
  });

  const reporting: Reporting = {
    site,
    log: options.log,
    tables,
    event: (input) => writer.event(input),
    captureError: (error, context) => capture(error, context),
    alert: fireAlert,
    flush: async (opts) => {
      await writer.flush(opts);
      await requests.flush();
    },
    requests: {
      record: (status, durationMs) => requests.record(status, durationMs),
      recordError: () => requests.recordError(),
    },
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
    stats: () => writer.stats(),
  };
  return reporting;
}
