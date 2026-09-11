# reporting

The estate's operational event log, its housekeeping tick and, from 0.2, its
analytics, published as `@wtfalch/reporting`. It sits beside `auth` (who is
this), `authz` (what may they do), `audit` (what did they do) and `design`
(what does it look like), and answers a fifth question: what did the system
do, and how is the product used.

The package is in `packages/reporting`; its README says what it holds and how
an app binds it, and its `PRIVACY.md` says what is stored and for how long.
The design it implements is `docs/plans/reporting.md` and
`docs/plans/reporting/core.md` in `wtfalch/app-template`.

```
pnpm install
pnpm build && pnpm lint && pnpm typecheck && pnpm test
```

Tests run on PGlite in memory by default. With `TEST_DATABASE_URL` pointing
at a throwaway Postgres 16 they run there instead, and the runtime-role and
two-connection cases run too; the database's public schema is dropped first.

Publishing is a tag. Bump the version in `packages/reporting/package.json`,
merge it, then push `v<version>`: `.github/workflows/release.yml` runs the
same gates CI runs, refuses a tag that disagrees with `package.json`, and
publishes with provenance when the repository has an `NPM_TOKEN` secret.
Check npm for the new version rather than the run's colour.
