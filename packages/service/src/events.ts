import type {
  EventInput,
  EventsPage,
  EventsPageOptions,
  Level,
  Reporting,
} from '@wtfalch/reporting-core';
import { ServiceError, errorResponse, handle, json, readJson, requirePermission } from './http.js';
import type { Mutable } from './http.js';
import type { ReportingPrincipal } from './principal.js';

export interface CreateEventsHandlerOptions {
  /** Only `event()` and `events.page()` are used -- the writer and the reader (writer.ts, reader.ts). */
  readonly reporting: Pick<Reporting, 'event' | 'events'>;
  readonly principal: ReportingPrincipal | null;
}

function record(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Loose on the wire, strict in `event()`: `writer.event()` runs the same
 * `eventInputSchema` this builds a candidate for, so a malformed field here
 * is refused there with the real validation message -- this just keeps
 * the obviously-wrong shapes (not even a string) out before that.
 */
function parseEventInput(body: unknown): EventInput {
  const kind = record(body, 'kind');
  const message = record(body, 'message');
  if (typeof kind !== 'string' || typeof message !== 'string') {
    throw new ServiceError('invalid_request', 'kind and message are required strings');
  }
  const input: Mutable<EventInput> = { kind, message };
  const level = record(body, 'level');
  if (typeof level === 'string') input.level = level as Level;
  const tenantId = record(body, 'tenantId');
  if (tenantId === null || typeof tenantId === 'string') input.tenantId = tenantId;
  const actor = record(body, 'actor');
  if (actor === null || typeof actor === 'object') input.actor = actor as EventInput['actor'];
  const requestId = record(body, 'requestId');
  if (requestId === null || typeof requestId === 'string') input.requestId = requestId;
  const target = record(body, 'target');
  if (target === null || typeof target === 'object') input.target = target as EventInput['target'];
  const data = record(body, 'data');
  if (typeof data === 'object' && data !== null) input.data = data as EventInput['data'];
  const occurredAt = record(body, 'occurredAt');
  if (typeof occurredAt === 'string') {
    const date = new Date(occurredAt);
    if (!Number.isNaN(date.getTime())) input.occurredAt = date;
  }
  return input;
}

function parseEventsQuery(url: URL): EventsPageOptions {
  const params = url.searchParams;
  const opts: Mutable<EventsPageOptions> = {};
  const limit = params.get('limit');
  if (limit !== null) {
    const n = Number(limit);
    if (!Number.isFinite(n)) throw new ServiceError('invalid_request', 'limit must be a number');
    opts.limit = n;
  }
  const level = params.get('level');
  if (level !== null) opts.level = level as Level;
  const kindNs = params.get('kindNs');
  if (kindNs !== null) opts.kindNs = kindNs;
  const tenantId = params.get('tenantId');
  if (tenantId !== null) opts.tenantId = tenantId;
  const site = params.get('site');
  if (site !== null) opts.site = site;
  const requestId = params.get('requestId');
  if (requestId !== null) opts.requestId = requestId;
  const environment = params.get('environment');
  if (environment !== null) opts.environment = environment;
  const afterOccurredAt = params.get('afterOccurredAt');
  const afterId = params.get('afterId');
  if (afterOccurredAt !== null && afterId !== null) {
    const occurredAt = new Date(afterOccurredAt);
    const id = Number(afterId);
    if (Number.isNaN(occurredAt.getTime()) || !Number.isFinite(id)) {
      throw new ServiceError('invalid_request', 'afterOccurredAt/afterId are not a valid cursor');
    }
    opts.after = { occurredAt, id };
  }
  return opts;
}

/**
 * `POST /` ingests one event through `reporting.event()`, which never
 * throws for a storage failure (writer.ts): once the permission and shape
 * checks pass, the response is always 202, whether or not the row is ever
 * written. `GET /` reads the page back (reader.ts); no permission beyond
 * `reporting:read` is applied inside it -- the host decides whether a
 * caller may see a given site or tenant at all, this route does not scope
 * by the caller's own identity.
 */
export function createEventsHandler(options: CreateEventsHandlerOptions) {
  return (request: Request): Promise<Response> =>
    handle(async () => {
      if (request.method === 'POST') {
        requirePermission(options.principal, 'reporting:ingest');
        const input = parseEventInput(await readJson(request));
        options.reporting.event(input);
        return json({ accepted: true }, 202);
      }
      if (request.method === 'GET') {
        requirePermission(options.principal, 'reporting:read');
        const page = await options.reporting.events.page(parseEventsQuery(new URL(request.url)));
        return json(page satisfies EventsPage);
      }
      return errorResponse('not_found', 'Route not found');
    });
}
