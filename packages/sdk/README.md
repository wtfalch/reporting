# @wtfalch/reporting-sdk

Scaffold client SDK and API types for the shared reporting collector service
(issue #42, `docs/plans/collector.md` slice 2). This is the toy domain
package-template's `service` shape ships, renamed to this repo's token and
wired into the root gate — it is not yet the real collector. The real
ingest/read surface, schema and forced row-level security land in slices
3-5 of the plan.

Requires Node 22+ or a browser with Fetch support. The client has no runtime
package dependencies.

## Status

Published: no. Private scaffold package (`0.0.0`), not installable from npm.
Once the real collector cuts over (`docs/adr/0001-shared-collector-service-shape.md`'s
"Consequence" section), this package's content moves into the existing
`packages/reporting`, which keeps publishing as `@wtfalch/reporting`
unchanged; this package does not publish under that name in the meantime.

```ts
import { createReportingClient } from '@wtfalch/reporting-sdk';

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
`@wtfalch/reporting-sdk/client` is also supported. There are no server,
database, migration or authorization exports. The service implementation is
a private package.
