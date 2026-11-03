# @wtfalch/reporting

Client SDK and API types for the reporting backend a company runs for itself
(`docs/adr/0002-one-backend-and-app-per-company.md`). Send events and errors,
read them back, read and set tenant settings, read release health -- the
other half is `packages/service`'s handler factories, mounted by that
company's data service.

Requires Node 22+ or a browser with Fetch support. The client has no runtime
package dependencies.

## Status

Version 2.0.0. The name `@wtfalch/reporting` was the library in 1.0.0 and
1.1.0; the library is now the private `@wtfalch/reporting-core`, and this
package is the client.

```ts
import { createReportingClient } from '@wtfalch/reporting';

const reporting = createReportingClient({
  baseUrl: serviceOrigin,
  credential: () => serviceKey,
});

reporting.sendEvent({ kind: 'billing.charge_failed', message: 'card declined' });
reporting.sendError({ message: error.message, stack: error.stack });

const { items } = await reporting.events.page({ limit: 50 });
const { items: groups } = await reporting.errors.page({ state: 'open' });
await reporting.errors.setState(groups[0].fingerprint, 'resolved');

const { settings } = await reporting.settings.get();
await reporting.settings.set({ 'events.retention_days': 14 });
await reporting.tenantSettings.set(tenantId, 'events.retention_days', 90);

const health = await reporting.releaseHealth(fromIso, toIso);
```

`sendEvent`, `sendError` and `recordRequest` are fire-and-forget: the service
answers 202 once the call is accepted, whether or not the row is ever
stored (the writer and capture paths never fail the caller over a storage
problem), so a resolved promise here means "accepted", not "durably
written". `createReporting`/`listReportings` are this package's original
scaffold calls, kept as they were; nothing else uses them yet.

The credential callback runs for every request, so rotation does not require a
new client. API failures reject with `ReportingApiError`, which carries `status`
and a typed `code` (see `ReportingError`); the SDK never throws a bare `Error`
for a service failure.

The root export provides the client and public request/response types.
`@wtfalch/reporting/client` is also supported. There are no server,
database, migration or authorization exports. The service implementation is
a private package.
