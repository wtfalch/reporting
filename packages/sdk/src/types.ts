/** Public HTTP contracts for the Reporting service. Internal storage rows are never returned. */
export interface Reporting {
  id: string;
  organisationId: string;
  name: string;
  createdAt: string;
}

export interface CreateReportingRequest {
  organisationId: string;
  name: string;
}

export interface ListReportingsResponse {
  reportings: Reporting[];
}

export type Level = 'info' | 'warn' | 'error' | 'alert';
export type ActorClass = 'human' | 'api_key' | 'agent' | 'service';
export type ErrorState = 'open' | 'resolved' | 'ignored';
export type ErrorRuntime = 'server' | 'edge' | 'browser';

export interface Actor {
  class: ActorClass;
  id: string;
}

/** What `sendEvent` takes. `occurredAt`, when given, is an ISO timestamp. */
export interface SendEventInput {
  kind: string;
  message: string;
  level?: Level;
  tenantId?: string | null;
  actor?: Actor | null;
  requestId?: string | null;
  target?: { type: string; id: string } | null;
  data?: Record<string, string | number | boolean | null>;
  occurredAt?: string;
}

export interface ReportingEvent {
  id: number;
  occurredAt: string;
  level: Level;
  kind: string;
  kindNs: string;
  site: string;
  environment: string | null;
  tenantId: string | null;
  requestId: string | null;
  message: string;
  data: Record<string, unknown>;
}

export interface EventsPageOptions {
  limit?: number;
  level?: Level;
  kindNs?: string;
  tenantId?: string;
  site?: string;
  requestId?: string;
  environment?: string;
  after?: { occurredAt: string; id: number };
}

export interface EventsPage {
  items: ReportingEvent[];
  next: { occurredAt: string; id: number } | null;
}

/** What `sendError` takes: a caller-side report, redacted server-side (errors/redact.ts) before anything stores it. */
export interface SendErrorInput {
  kind?: string;
  message: string;
  stack?: string;
  runtime?: ErrorRuntime;
  tenantId?: string | null;
  requestId?: string | null;
  release?: string | null;
}

export interface ErrorGroup {
  fingerprint: string;
  site: string;
  environment: string | null;
  kind: string;
  message: string | null;
  stack: string | null;
  runtime: ErrorRuntime | null;
  release: string | null;
  color: string | null;
  requestId: string | null;
  resolvedBy: string | null;
  state: ErrorState | null;
  resolvedAt: string | null;
  tenantId: string | null;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ErrorsPageOptions {
  limit?: number;
  site?: string;
  state?: ErrorState;
  runtime?: ErrorRuntime;
  search?: string;
  environment?: string;
  tenantId?: string;
  after?: { lastSeenAt: string; fingerprint: string };
}

export interface ErrorsPage {
  items: ErrorGroup[];
  next: { lastSeenAt: string; fingerprint: string } | null;
}

export interface RecordRequestInput {
  status?: number;
  durationMs?: number;
  error?: true;
}

export interface ReportingSettings {
  'events.retention_days': number;
}

export type TenantRetentionKey = keyof ReportingSettings;

export interface TenantRetentionOverrides {
  overrides: Partial<Record<TenantRetentionKey, number>>;
}

export interface ReleaseHealth {
  colors: {
    blue: { requests: number; errors: number };
    green: { requests: number; errors: number };
  };
  daily: { days: number; requestsPerDay: number; errorsPerDay: number };
  from: string;
  to: string;
}

/** The wire shape of a failed request, discriminated on `code` so a caller can
 * narrow on it. Every non-2xx response body has this shape. */
export type ReportingError =
  | { code: 'invalid_request'; message: string }
  | { code: 'unauthorized'; message: string }
  | { code: 'forbidden'; message: string }
  | { code: 'not_found'; message: string }
  | { code: 'unavailable'; message: string };

export type ReportingErrorCode = ReportingError['code'];
