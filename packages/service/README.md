# @wtfalch/reporting-service

Scaffold: the toy domain package-template's `service` shape ships, renamed
to this repo's token (issue #42, `docs/plans/collector.md` slice 2). Not the
real collector yet -- schema, forced row-level security and the real
write/read surface land in slices 3-5. Never published -- `"private": true`,
and `prepublishOnly` throws. Nothing in this package is published; the SDK
half (`packages/sdk`, `@wtfalch/reporting-sdk`) is a private scaffold too
until a later slice cuts over.

A reporting belongs to an organisation and has a name. Two operations over
HTTP: create a reporting (`POST /v1/reportings`), list an organisation's reportings
(`GET /v1/reportings?organisationId=...`). Both are gated by
`@wtfalch/authz` (`reportings:read`, `reportings:create`) before the store is
touched.

## Development

Requires Node 22+ and pnpm 10.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

Tests use PGlite by default. Set `TEST_DATABASE_URL` to a **disposable**
PostgreSQL database to also exercise the real driver; each test creates and
drops its own randomly named schema.

## Composition

`createReportingHandler({ store, resolveAccess, audit })` is the HTTP entry
point. `resolveAccess` and `audit` are injected, not built here: the host
authenticates the caller through its own auth stack, binds a
`ResourceAccess` (from `@wtfalch/authz`) and supplies an audit sink. This
package owns permissions, migrations and storage; the host is the
composition root.

`migrate(db)` applies `src/migrations/*.sql` (copied to `dist/migrations` on
build) in order, recording applied names, and is idempotent.
