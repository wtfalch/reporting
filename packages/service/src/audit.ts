import type { Actor, Db, ErrorState } from '@wtfalch/reporting-core';
import { auditEvents } from './tables.js';

/** An operator action on a site key. Never carries the secret. */
export interface SiteKeyAuditEvent {
  readonly operation: 'site_key.mint' | 'site_key.revoke';
  readonly keyId: string;
  readonly site?: string;
}

/** An operator moving an error group's state, with who pressed the button. */
export interface StateAuditEvent {
  readonly operation: 'error.state';
  readonly site: string;
  readonly fingerprint: string;
  readonly state: ErrorState;
  readonly by: Actor;
}

/** An operator saving a site's error-email rules, with who saved them. */
export interface AlertRuleAuditEvent {
  readonly operation: 'alert_rule.set';
  readonly site: string;
  readonly by: Actor;
}

/** An operator recording when a release went up on a site's environment. */
export interface ReleaseAuditEvent {
  readonly operation: 'release.recorded';
  readonly site: string;
  readonly environment: string;
  readonly release: string;
}

export type AuditEvent =
  | SiteKeyAuditEvent
  | StateAuditEvent
  | AlertRuleAuditEvent
  | ReleaseAuditEvent;

/**
 * One row in the append-only `audit_events` table. The handler always passes
 * the transaction that made the change, so the row commits or rolls back
 * with it, and a failed write undoes the change. A read writes none: the
 * reader (Boule) audits who looked.
 */
export async function writeAudit(
  db: Db,
  tenantId: string | null,
  event: AuditEvent,
): Promise<void> {
  if (event.operation === 'alert_rule.set') {
    await db.insert(auditEvents).values({
      operation: event.operation,
      tenantId,
      site: event.site,
      actorClass: event.by.class,
      actorId: event.by.id,
    });
    return;
  }
  if (event.operation === 'release.recorded') {
    await db.insert(auditEvents).values({
      operation: event.operation,
      tenantId,
      site: event.site,
      environment: event.environment,
      release: event.release,
    });
    return;
  }
  await db.insert(auditEvents).values(
    event.operation === 'error.state'
      ? {
          operation: event.operation,
          tenantId,
          site: event.site,
          fingerprint: event.fingerprint,
          state: event.state,
          actorClass: event.by.class,
          actorId: event.by.id,
        }
      : {
          operation: event.operation,
          tenantId,
          site: event.site ?? null,
          keyId: event.keyId,
        },
  );
}
