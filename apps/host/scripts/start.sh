#!/bin/sh
# Runner image entrypoint: migrate as the owner, then serve as the runtime
# role with the owner credential removed from the server process. Copied
# from wtfalch/analytics' apps/host/scripts/start.sh.
#
# WHY THIS RUNS HERE AND NOT IN CI OR A SEPARATE JOB
# ---------------------------------------------------
# The host's Coolify app builds only the Dockerfile's `runner` target, and
# production's Postgres has no port a GitHub runner could reach.
# `wtfalch/cms` went live with an empty database and no runtime role when
# its migration was a separate stage nothing ran: `_migrations` was never
# created, and /api/health's runtime-role check 503'd with no role to
# inspect, so every deploy's health check failed and Coolify rolled back
# (analytics ADR 0006's incident note, 2026-09-24). Running the migration
# inside the container that is about to serve means the schema and the code
# that expects it always move together, and a migration that fails exits
# this script non-zero -- the container never starts serving and never
# reads healthy.
#
# WHY DATABASE_URL_OWNER IS REMOVED BEFORE THE SERVER STARTS
# ------------------------------------------------------------
# migrate.mjs needs the owner connection to create tables and the runtime
# role (`ensureRuntimeRole` from `@wtfalch/db/runtime-role`). The server must
# never hold that credential: a bug in request-handling code that reached it
# would query as a role that can rewrite the audit log and every grant
# (analytics ADR 0014). `env -u` drops the variable from the child's
# environment without touching this shell's; `exec` replaces this process so
# node becomes PID 1 and gets Coolify's SIGTERM directly instead of a shell
# forwarding it late.
#
# `runMigrationSources` from `@wtfalch/db/migrate` takes a Postgres advisory
# lock for the whole run, so two containers overlapping during a rolling
# deploy serialize instead of racing each other's migration.
set -eu

here="$(dirname "$0")"
node "$here/migrate.mjs"
exec env -u DATABASE_URL_OWNER node "$here/../server.js"
