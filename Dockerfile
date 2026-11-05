# syntax=docker/dockerfile:1.7
# The reporting host (apps/host), one per company: copied from
# wtfalch/analytics' Dockerfile, with the two migration packages this host
# applies (core's, then the service's) in place of analytics' one.
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/reporting/package.json ./packages/reporting/package.json
COPY packages/service/package.json ./packages/service/package.json
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY apps/host/package.json ./apps/host/package.json
RUN --mount=type=cache,id=reporting-pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build
# The runner copies three pnpm store directories by glob. A glob that matches
# two (two versions) would merge them silently; one that matches none fails
# COPY only after the whole build. Fail here, with the glob's name, unless
# each matches exactly one.
RUN cd node_modules/.pnpm && for glob in '@wtfalch+db@*' 'postgres@*' 'postgres-array@3*'; do \
      count=$(ls -d $glob 2>/dev/null | wc -l); \
      [ "$count" -eq 1 ] || { echo "Dockerfile: $glob matches $count directories in node_modules/.pnpm, want exactly 1"; exit 1; }; \
    done

# Migrations run inside the runner's own entrypoint (apps/host/scripts/start.sh),
# not in a stage of their own: a Coolify app builds only the `runner` target,
# and a separate migration stage nothing ran is how wtfalch/cms went live with
# an empty database (analytics ADR 0006's incident note, 2026-09-24). The
# stage that migrated and the stage that serves are the same container and can
# never disagree about whether one ran.
FROM node:22-alpine AS runner
RUN apk add --no-cache curl && addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
WORKDIR /app
# Coolify passes the commit it is building as the `SOURCE_COMMIT` build arg;
# baked into `APP_VERSION` here (an ARG does not survive into a later stage's
# ENV on its own) so /api/health can report which commit this image is.
# Defaults to "unknown" for a plain `docker build` with no build arg passed.
ARG SOURCE_COMMIT=unknown
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 APP_VERSION=$SOURCE_COMMIT
COPY --from=builder --chown=nextjs:nodejs /app/apps/host/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/host/.next/static ./apps/host/.next/static
# migrate.mjs is invoked directly by start.sh, never imported by any route,
# so Next's output tracing (which only follows imports reachable from a
# route or page into .next/standalone) never sees it or the SQL it reads --
# all of it is copied explicitly here.
#
# What migrate.mjs imports, and so what must be on disk (Next bundles the
# routes' copies of these into each route's own compiled chunk, so
# `.next/standalone/node_modules` holds none of them):
#   - `@wtfalch/db` (migrate, runtime-role): the real package. Its two
#     dependencies sit beside it in pnpm's store, not inside it, so they are
#     copied separately: `postgres` (no dependencies of its own) and
#     `postgres-array` (db pins one exact version, hence the `3*` glob: a db
#     release that moves it fails the check above, not the container start).
#   - `@wtfalch/reporting-service/migrations-dir`: the service's SQL. Only its
#     package.json (for the `exports` map and `"type": "module"`), that one
#     module and the SQL are needed, not the package's other imports.
#   - `@wtfalch/reporting-core/migrations-dir`, which the service's module
#     imports for core's SQL: the same three pieces of core. Its module
#     imports `node:url` and nothing else.
# Node's module resolution walks up from each of these to /app/node_modules,
# so the copies are visible to one another and to `import ... from
# '@wtfalch/db/migrate'` without any symlink of their own.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.pnpm/@wtfalch+db@*/node_modules/@wtfalch/db ./node_modules/@wtfalch/db
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.pnpm/postgres@*/node_modules/postgres ./node_modules/postgres
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.pnpm/postgres-array@3*/node_modules/postgres-array ./node_modules/postgres-array
COPY --from=builder --chown=nextjs:nodejs /app/packages/reporting/package.json ./node_modules/@wtfalch/reporting-core/package.json
COPY --from=builder --chown=nextjs:nodejs /app/packages/reporting/dist/migrations-dir.js ./node_modules/@wtfalch/reporting-core/dist/migrations-dir.js
COPY --from=builder --chown=nextjs:nodejs /app/packages/reporting/dist/migrations ./node_modules/@wtfalch/reporting-core/dist/migrations
COPY --from=builder --chown=nextjs:nodejs /app/packages/service/package.json ./node_modules/@wtfalch/reporting-service/package.json
COPY --from=builder --chown=nextjs:nodejs /app/packages/service/dist/migrations-dir.js ./node_modules/@wtfalch/reporting-service/dist/migrations-dir.js
COPY --from=builder --chown=nextjs:nodejs /app/packages/service/dist/migrations ./node_modules/@wtfalch/reporting-service/dist/migrations
COPY --from=builder --chown=nextjs:nodejs /app/apps/host/scripts/migrate.mjs ./apps/host/scripts/migrate.mjs
COPY --from=builder --chown=nextjs:nodejs /app/apps/host/scripts/runtime-grants.mjs ./apps/host/scripts/runtime-grants.mjs
COPY --from=builder --chown=nextjs:nodejs /app/apps/host/scripts/start.sh ./apps/host/scripts/start.sh
# The host's own migrations: the directory, not `*.sql`, because the host owns
# no table yet and a glob that matches nothing fails the COPY.
COPY --from=builder --chown=nextjs:nodejs /app/apps/host/drizzle ./apps/host/drizzle
USER nextjs
EXPOSE 3000
# start-period covers migrate.mjs's own database wait (`waitMs: 60_000`) plus
# time to apply every pending migration on a cold, never-migrated database,
# before Coolify's rolling deploy gives up and rolls back. Once healthy,
# interval/timeout stay tight.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:3000/api/health || exit 1
CMD ["./apps/host/scripts/start.sh"]
