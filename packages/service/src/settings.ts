import type { Reporting, Settings, TenantRetentionKey } from '@wtfalch/reporting-core';
import { TENANT_RETENTION_KEYS } from '@wtfalch/reporting-core';
import { ServiceError, errorResponse, handle, json, readJson, requirePermission } from './http.js';
import type { ReportingPrincipal } from './principal.js';

export interface CreateSettingsHandlerOptions {
  /** Only `settings` and `tenantSettings` are used (settings.ts, through the facade so a change still emits the `reporting.settings_changed` event). */
  readonly reporting: Pick<Reporting, 'settings' | 'tenantSettings'>;
  readonly principal: ReportingPrincipal | null;
}

function record(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

/** `settings.ts`'s own validation throws a plain `Error`, synchronously, before any write -- never a storage failure. */
async function asInvalidRequest<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(
      'invalid_request',
      error instanceof Error ? error.message : 'Invalid settings',
    );
  }
}

/** `/tenants/<id>` for one tenant's overrides, otherwise the site-wide settings. */
function tenantIdOf(url: URL): string | null {
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  const at = segments.indexOf('tenants');
  return at === -1 ? null : (segments[at + 1] ?? null);
}

/**
 * `GET`/`PUT /` read and change the site-wide settings; `GET`/`PUT
 * /tenants/:tenantId` read and change one tenant's override of a retention
 * key (settings.ts's per-tenant gap, issue #11). Both read and write are
 * gated on `reporting:settings` -- an operator who may see the value may
 * also change it, and a form that reads a setting before offering to
 * change it needs no second permission.
 */
export function createSettingsHandler(options: CreateSettingsHandlerOptions) {
  return (request: Request): Promise<Response> =>
    handle(async () => {
      const principal = requirePermission(options.principal, 'reporting:settings');
      const url = new URL(request.url);
      const tenantId = tenantIdOf(url);

      if (tenantId !== null) {
        if (request.method === 'GET') {
          const overrides = await options.reporting.tenantSettings.get(tenantId);
          return json({ overrides });
        }
        if (request.method === 'PUT') {
          const body = await readJson(request);
          const key = record(body, 'key');
          if (
            typeof key !== 'string' ||
            !(TENANT_RETENTION_KEYS as readonly string[]).includes(key)
          ) {
            throw new ServiceError(
              'invalid_request',
              `key must be one of ${TENANT_RETENTION_KEYS.join(', ')}`,
            );
          }
          const days = record(body, 'days');
          if (days !== null && typeof days !== 'number') {
            throw new ServiceError('invalid_request', 'days must be a number or null');
          }
          await asInvalidRequest(() =>
            options.reporting.tenantSettings.set(
              tenantId,
              key as TenantRetentionKey,
              days,
              principal.actor,
            ),
          );
          const overrides = await options.reporting.tenantSettings.get(tenantId);
          return json({ overrides });
        }
        return errorResponse('not_found', 'Route not found');
      }

      if (request.method === 'GET') {
        return json({ settings: await options.reporting.settings.get() });
      }
      if (request.method === 'PUT') {
        const body = await readJson(request);
        if (typeof body !== 'object' || body === null) {
          throw new ServiceError('invalid_request', 'A JSON object body is required');
        }
        const change = await asInvalidRequest(() =>
          options.reporting.settings.set(body as Partial<Settings>, principal.actor),
        );
        return json({ settings: change.after });
      }
      return errorResponse('not_found', 'Route not found');
    });
}
