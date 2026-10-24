# @wtfalch/reporting

Client SDK and API types for the reporting backend a company runs for itself
(`docs/adr/0002-one-backend-and-app-per-company.md`). This is still the
scaffold client; the real send and read calls land in later tasks.

Requires Node 22+ or a browser with Fetch support. The client has no runtime
package dependencies.

## Status

Version 2.0.0. The name `@wtfalch/reporting` was the library in 1.0.0 and
1.1.0; the library is now the private `@wtfalch/reporting-core`, and this
package is the client.

```ts
import { createReportingClient } from '@wtfalch/reporting';

const reportings = createReportingClient({
  baseUrl: serviceOrigin,
  credential: () => serviceKey,
});

const reporting = await reportings.createReporting({ organisationId, name: 'Widget' });
const { reportings: list } = await reportings.listReportings(organisationId);
```

The credential callback runs for every request, so rotation does not require a
new client. API failures reject with `ReportingApiError`, which carries `status`
and a typed `code` (see `ReportingError`); the SDK never throws a bare `Error`
for a service failure.

The root export provides the client and public request/response types.
`@wtfalch/reporting/client` is also supported. There are no server,
database, migration or authorization exports. The service implementation is
a private package.
