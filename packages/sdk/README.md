# @wtfalch/reporting

The client for the reporting backend a company runs for itself
(`docs/adr/0002-one-backend-and-app-per-company.md`, `docs/plans/backend.md`):
an app sends its errors there, and Boule reads them back.

No dependencies and no Node imports: it runs in a Cloudflare Worker, Node 22+
and a browser with Fetch.

## 2.0.0

`@wtfalch/reporting` 1.0.0 and 1.1.0 were the library that wrote to an app's
own Postgres. That library is now the private `@wtfalch/reporting-core`, and
this package is the client. An app moving from 1.x replaces its
`captureError` with a sender. The backend fingerprints with the same code but
groups per site and environment, so an error's fingerprint there differs from
the one the app stored itself, and its groups start afresh.

A group's `fingerprint` is 32 lower-case hex characters and implies its site
and environment. Two apps that throw the same way, or one app's production
and stage, are separate groups.

## Sending errors (an app)

```ts
import { createErrorSender } from '@wtfalch/reporting';

const errors = createErrorSender({
  url: env.REPORTING_URL,          // https://reporting.<domain>
  siteKey: env.REPORTING_SITE_KEY, // ci_rk_..., minted by foundry
  release: env.RELEASE,
});

try {
  await work();
} catch (error) {
  ctx.waitUntil(errors.capture(error, { runtime: 'edge', requestId }));
  throw error;
}
```

- `send(report)` queues an `ErrorReport`; `capture(error, context?)` builds
  one from a thrown value. Both return a promise that settles when the request
  carrying the report has finished, and **never rejects**. Pass it to
  `ctx.waitUntil()` in a Worker.
- Reports are batched to the backend's limits (20 a request, 64 KB a body),
  and each request is bounded by `timeoutMs` (default 5000). A failed request
  is logged and not retried.
- A `401` means the site key is unknown or revoked. It is logged once, and
  the sender drops every report after it without sending.
- The log (default `console.warn`) gets fixed text only, never a report's
  text or the site key.
- The sender redacts nothing; the backend redacts on ingest. Take out any
  secret you know of (a login, a password) before you put it in a message.
  Where in the app the error happened belongs in the message or the stack.

## Reading errors (Boule)

```ts
import { createErrorReader } from '@wtfalch/reporting';

const reader = createErrorReader({
  url: env.REPORTING_URL,
  operatorKey: env.REPORTING_OPERATOR_KEY,
});

const { items, next } = await reader.list({ site: appKey, environment: 'production' });
const group = await reader.get({ site: appKey, fingerprint });
await reader.setState({ site: appKey, fingerprint, state: 'resolved', by: { class: 'human', id } });
const { buckets } = await reader.series({ site: appKey, from, to, bucket: 60 });
```

A failure rejects with `ReportingApiError`, which carries `status` and a
typed `code` (`ReportingErrorCode`: `invalid_request`, `unauthorized`,
`forbidden`, `not_found`, `not_configured`, `rate_limited`, `unavailable`).
An unknown group is `not_found`. A lost connection or a timeout is
`unavailable` with status 0. The operator key reads every app's errors, so
the reader belongs on a server.

## Entries

`@wtfalch/reporting` exports both. `@wtfalch/reporting/sender` and
`@wtfalch/reporting/reader` export each on its own. There are no server,
database or migration exports: the backend is the private
`@wtfalch/reporting-service`.
