# reporting

The estate's operational event log, its housekeeping tick and, from 0.2, its
analytics, published as `@wtfalch/reporting`. It sits beside `auth` (who is
this), `authz` (what may they do), `audit` (what did they do) and `design`
(what does it look like), and answers a fifth question: what did the system
do, and how is the product used.

The package is in `packages/reporting`; its README says what it holds and how
an app binds it, and its `PRIVACY.md` says what is stored and for how long.
The design it implements was originally `docs/plans/reporting.md` and
`docs/plans/reporting/core.md` in `wtfalch/app-template`, which was archived
2026-09-24 and replaced by `foundry`; those docs are a historical record only.
The design history for everything past 0.2.0 lives in this repo's own
`docs/plans/errors.md` and `CHANGELOG.md`.

```
pnpm install
pnpm check
```

Tests run on PGlite in memory by default. With `TEST_DATABASE_URL` pointing
at a throwaway Postgres 16 they run there instead, and the runtime-role and
two-connection cases run too. Each test file gets a uniquely named schema,
dropped afterwards; `public` is never touched, and the runtime-role test
creates and drops its own role.

Publishing is a tag. Bump the version in `packages/reporting/package.json`,
merge it, then push `v<version>`: `.github/workflows/release.yml` runs the
same gates CI runs, refuses a tag that disagrees with `package.json`, and
publishes with provenance through npm trusted publishing (OIDC), so the
repository holds no npm token. The first version, 0.1.0, went out from a
laptop because a package has to exist before npm can trust a publisher for
it.

## The shared collector (issue #42)

`docs/adr/0001-shared-collector-service-shape.md` and `docs/plans/collector.md`
track moving to one shared, org-scoped collector service. `packages/sdk`
(`@wtfalch/reporting-sdk`) is the first piece of slice 2's scaffold for that
shape -- package-template's `service`-shape toy, renamed to this repo's
token, private and unpublished, `pnpm check`-clean. `packages/service`
follows in a stacked PR. `packages/reporting` keeps publishing as
`@wtfalch/reporting` unchanged; no app has moved off it yet.
