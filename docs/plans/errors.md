# @wtfalch/reporting 0.3.0 — the error record

Decided 2026-09-20: Sentry leaves the estate. `@wtfalch/reporting` takes the one
thing it did that this package cannot — an uncaught exception, with its stack,
grouped so a list of errors is readable rather than a firehose.

## What Sentry did that 0.2.1 does not

Measured in app-template on 2026-09-20:

1. **Uncaught exceptions with stack traces** — `onRequestError` in
   `src/instrumentation.ts`, `Sentry.captureException` in `src/app/error.tsx`,
   `src/app/global-error.tsx` and twice in `src/lib/authz/startup.ts`.
2. **Client source-map upload** — `Dockerfile:50-65`, `@sentry/cli`.
3. **Traces at 10%** — `tracesSampleRate: 0.1` in all three init files.

Item 3 is dropped, not replaced: nothing in the estate reads a trace today.
Item 2 is out of this slice; server stacks are not minified, and a minified
client stack is still a fingerprint. Item 1 is what this builds.

## Why a second table, not just an event row

`reporting_events` already refuses what an error needs. `message` is capped at
512 characters and `data` must be flat, under 16 KB, with banned keys
(`migrations/0001_reporting.sql`). A stack would fit as a `data.stack` string,
but that is the smaller problem.

The larger one: one row per exception is a firehose. The same throw on every
request writes a thousand identical rows, and the operator reads none of them.
What makes an error list usable is grouping — first seen, last seen, how many,
and has anyone dealt with it.

So capture writes **both**:

- one `reporting_events` row, kind `error.<class>`, level `error` — the
  timeline, already indexed (`reporting_events_problem_time_idx`) and already
  pruned by `reporting.prune_events`.
- one upsert into a new `reporting_errors` — the group, holding counts and the
  most recent sample.

Nothing new is invented for retention, flushing or the operator's filters.

## The table (`migrations/0003_errors.sql`)

```
reporting_errors
  fingerprint     text primary key
  site            text not null
  kind            text not null        -- the error class: TypeError, ZodError
  message         text not null        -- bounded 512, redacted
  stack           text                 -- bounded 16384, redacted
  runtime         text not null        -- server | edge | browser
  release         text                 -- so "new since this deploy" is a query
  first_seen_at   timestamptz not null
  last_seen_at    timestamptz not null
  occurrences     bigint not null default 1
  state           text not null default 'open'   -- open | resolved | ignored
  resolved_at     timestamptz
  resolved_by     text
  tenant_id       uuid                 -- from the most recent sample
  request_id      text                 -- from the most recent sample
```

Same estate shape as 0001: idempotent statements, the runtime-role DO block,
CHECK constraints mirrored in `src/schema.ts`, and `schema.test.ts` pinning the
two lists equal.

## Fingerprint

`sha256(kind + '\n' + top five normalised frames)`, truncated to 32 hex chars.

A frame normalises by dropping the absolute path prefix, the line and column
numbers, and any `node_modules` segment. Line numbers drift on every edit, so
including them would split one error into a new group per deploy — the failure
mode that makes a grouped list worthless.

A throw with no stack fingerprints on `kind + message`.

## Redaction is the package's, not the host's

`app-template/src/lib/redact.ts` (97 lines) exists because a stack or a message
is the likeliest way a wrapping key leaves the process — a boot crash with the
environment attached, a parse error quoting what it could not read. It runs
today as Sentry's `beforeSend`.

When Sentry goes, that guard must not go with it. It moves into this package and
runs on the capture path, before the row is queued, on both `message` and
`stack`. The host keeps no copy.

## Surface

```
.                 captureError(error, context?)   on the Reporting instance
                  errorsPage(), errorDetail(), setErrorState()
./next            errorHandler()      -> bind to Next's onRequestError
                  clientErrorHandler() -> the public ingest route
./browser         beacon gains window.onerror + unhandledrejection
./react           an errors table on @wtfalch/design, like the analytics readers
./housekeeping    pruneErrors — resolved and untouched past retention
```

The browser path reuses the analytics collector's shape: a public route, the
same batching and the same caps, because that ingest problem is already solved
here (`src/analytics/collector.ts`) and inventing a second one would mean a
second set of limits to get wrong.

## Done-checks

Each is a command, run in `/Users/william.falch/Documents/dev/reporting`:

1. `pnpm -r test` — green, including new suites for the fingerprint normaliser,
   the redactor and the upsert-on-repeat behaviour.
2. `pnpm -r typecheck` — clean.
3. `pnpm lint` — clean.
4. `pnpm --filter @wtfalch/reporting test src/migration.test.ts` — 0003 applies
   to an empty Postgres and is idempotent on a second run.
5. A property test: the same throw from two different line numbers in the same
   function fingerprints the same; two different errors do not collide.
6. The redactor: a stack carrying a `k1:<base64>` wrapping key leaves with it
   replaced, asserted on both `message` and `stack`.

## Then app-template

A separate pull request, after 0.3.0 is on npm. It removes:

| Path | Lines |
| --- | --- |
| `bootstrap/clients/sentry.ts` | 153 |
| `bootstrap/steps/sentry-project.ts` | 126 |
| `sentry.server.config.ts` | 22 |
| `sentry.edge.config.ts` | 17 |
| `src/lib/redact.ts` (moves into the package) | 97 |
| `instrumentation-client.ts` (Sentry init only) | 24 |
| the `sentry` module in `bootstrap/modules/index.ts` | — |
| `Dockerfile` source-map upload + 4 ARGs | ~20 |
| `@sentry/nextjs` from `package.json` | — |

and rebinds `src/instrumentation.ts`, both error boundaries,
`src/lib/authz/startup.ts` and `src/lib/reporting/core.ts`'s `onAlert`.

## Not in this slice

Source maps and symbolication. Traces. An alerting rule engine — `onAlert` is
still the host's hook, and a pager is a later decision now that nothing pages.
