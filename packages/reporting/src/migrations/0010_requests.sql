-- @wtfalch/reporting 0.8.0: a request counter, one row per minute.
-- Mirrors src/tables.ts.
--
-- Blue/green judges a new color by its share of failed responses, which needs
-- a count of all requests, not one event per request. The app counts in
-- memory and writes one upsert per minute bucket, color and release.
-- `errors` is responses with status >= 500. `color` and `release` are the
-- empty string, not null, when the app has none, so they can sit in the
-- primary key. Counts only; nothing here identifies a person or a request.
-- Every statement is idempotent.
--
-- The table is new, so there are no live rows to scan and the CHECKs go in
-- the plain way. Select, insert and update for the runtime role; nothing that
-- deletes (the host's ensureRuntimeRole call sets that; see the README).

create table if not exists reporting_requests (
  bucket    timestamptz not null,
  site      text not null,
  color     text not null default '',
  release   text not null default '',
  requests  bigint not null default 0,
  errors    bigint not null default 0,
  constraint reporting_requests_pkey primary key (bucket, site, color, release),
  constraint reporting_requests_site_check check (site ~ '^[a-z][a-z0-9-]{0,63}$'),
  constraint reporting_requests_color_check check (color in ('', 'blue', 'green')),
  constraint reporting_requests_counts_check check (requests >= 0 and errors between 0 and requests)
);
