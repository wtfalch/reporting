import { type ClientOptions, createTransport } from './transport.js';
import type {
  CreateReportingRequest,
  ErrorGroup,
  ErrorState,
  ErrorsPage,
  ErrorsPageOptions,
  EventsPage,
  EventsPageOptions,
  ListReportingsResponse,
  RecordRequestInput,
  ReleaseHealth,
  Reporting,
  ReportingSettings,
  SendErrorInput,
  SendEventInput,
  TenantRetentionKey,
  TenantRetentionOverrides,
} from './types.js';

export { ReportingApiError, type ClientOptions } from './transport.js';

function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/**
 * The real client: write events and errors, read them back, read and set
 * tenant settings, read release health
 * (`docs/adr/0002-one-backend-and-app-per-company.md`). Every write is
 * fire-and-forget on the wire -- the service answers 202 whether or not the
 * row is ever stored (packages/service's writer/capture routes), so this
 * client treats a 202 the same as any other success and never retries one
 * on the caller's behalf.
 *
 * `createReporting`/`listReportings` are the earlier scaffold's toy calls,
 * kept as-is (see the campaign issue's Decide note) alongside the real
 * surface below.
 */
export function createReportingClient(options: ClientOptions) {
  const call = createTransport(options);
  return {
    createReporting: (input: CreateReportingRequest) =>
      call<Reporting>('POST', '/v1/reportings', input),
    listReportings: (organisationId: string) =>
      call<ListReportingsResponse>(
        'GET',
        `/v1/reportings?${new URLSearchParams({ organisationId })}`,
      ),

    /** Always resolves once accepted; never fails for a storage problem (packages/service/src/events.ts). */
    sendEvent: (input: SendEventInput) => call<{ accepted: true }>('POST', '/events', input),
    events: {
      page: (opts: EventsPageOptions = {}) =>
        call<EventsPage>(
          'GET',
          `/events${queryString({
            limit: opts.limit,
            level: opts.level,
            kindNs: opts.kindNs,
            tenantId: opts.tenantId,
            site: opts.site,
            requestId: opts.requestId,
            environment: opts.environment,
            afterOccurredAt: opts.after?.occurredAt,
            afterId: opts.after?.id,
          })}`,
        ),
    },

    /** Always resolves once accepted; redacted server-side before storage (errors/redact.ts) and never fails for a storage problem. */
    sendError: (input: SendErrorInput) => call<{ accepted: true }>('POST', '/errors', input),
    errors: {
      page: (opts: ErrorsPageOptions = {}) =>
        call<ErrorsPage>(
          'GET',
          `/errors${queryString({
            limit: opts.limit,
            site: opts.site,
            state: opts.state,
            runtime: opts.runtime,
            search: opts.search,
            environment: opts.environment,
            tenantId: opts.tenantId,
            afterLastSeenAt: opts.after?.lastSeenAt,
            afterFingerprint: opts.after?.fingerprint,
          })}`,
        ),
      get: (fingerprint: string, opts: { tenantId?: string } = {}) =>
        call<{ error: ErrorGroup }>(
          'GET',
          `/errors/${fingerprint}${queryString({ tenantId: opts.tenantId })}`,
        ),
      setState: (fingerprint: string, state: ErrorState) =>
        call<{ error: ErrorGroup }>('PATCH', `/errors/${fingerprint}`, { state }),
    },

    /** Counts one response for the release reads; always resolves once accepted (packages/service/src/requests.ts). */
    recordRequest: (input: RecordRequestInput) =>
      call<{ accepted: true }>('POST', '/requests', input),

    settings: {
      get: () => call<{ settings: ReportingSettings }>('GET', '/settings'),
      set: (patch: Partial<ReportingSettings>) =>
        call<{ settings: ReportingSettings }>('PUT', '/settings', patch),
    },
    tenantSettings: {
      get: (tenantId: string) =>
        call<TenantRetentionOverrides>('GET', `/settings/tenants/${tenantId}`),
      /** `days: null` clears the override, falling back to the site-wide default. */
      set: (tenantId: string, key: TenantRetentionKey, days: number | null) =>
        call<TenantRetentionOverrides>('PUT', `/settings/tenants/${tenantId}`, { key, days }),
    },

    releaseHealth: (from: string, to: string) =>
      call<ReleaseHealth>('GET', `/release-health${queryString({ from, to })}`),
  };
}
