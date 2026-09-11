# What this package stores, and for how long

## `reporting_events`

One row per operational event the host writes. Kept for `events.retention_days`
(default 30, bounds 7 to 400), then deleted by `reporting_prune_events` from
the housekeeping tick. Nothing else deletes a row: the estate's runtime role
has no DELETE on the table.

A row carries:

- `kind`, `level`, `message` (≤ 512 characters), `site`, `occurred_at`.
- `tenant_id`, an organisation's uuid, when the host attributed the event.
- `actor_class` and `actor_id`: an issuer or credential id when the host
  passed one. **This is a linkable identifier and personal data.** It has no
  foreign key and no cascade, on purpose: rows leave by age, not by erasure,
  and the retention window is the mechanism. The host's tenancy notes state
  this exception; a host that must erase operational rows on request has to
  prune the table itself with a shorter window or a host-owned sweep.
- `request_id`: Cloudflare's ray id or a uuid. Not personal on its own; it
  joins an event to the audit rows of the same request.
- `target_type` and `target_id`: what the event was about, as ids.
- `data`: a flat object of scalars, at most 16 KB. The table refuses nested
  values and the keys `email`, `name`, `display_name`, `displayName`,
  `password`, `secret`, `token` and `authorization`. That is a guardrail
  against the accidental case, not proof of absence: a string under any
  other key can still carry an address or a secret. Write fixed message
  templates and event-specific fields; never forward a request body, a
  provider response or an error object.

Never stored: an ip address, a user agent, an email address, a display name,
a message body.

## `reporting_tasks`

One row per housekeeping task: due time, lease, claim token, last outcome and
a bounded error string. No personal data.

## `reporting_settings`

Operator-edited settings by key; `updated_by` is the editing actor's class and
id. Kept indefinitely; a host may erase `updated_by` on request.

## Who can read

Nothing here decides. The host gates its pages; the package's readers return
rows as stored.

## Analytics (0.2.0)

**Raw rows** (`reporting_analytics`), kept for `analytics.retention_days`
(default 90, bounded 7 to 400, never past what the rollups still need): when,
which site, a route pattern (identifiers replaced by placeholders before
storage), an event name, the referrer's host, a device class, a country code,
flat props under 4 KB without personal keys, and three ids: the first-party
cookie's visitor id when the person consented, a per-tab session id, and the
signed-in person's issuer id set server-side from the session
(`analytics.identify_signed_in`, default on). Never an ip address, a user
agent, an email, a name or a query string.

**Rollups** (`reporting_analytics_daily`, `reporting_analytics_weekly`),
kept indefinitely: counts per day or week, site, organisation, event name,
route, device, country and referrer host. No identifier in any column;
buckets under five distinct visitors render as `(few)` to a customer
organisation.

**Erasure**: `reporting_erase_person` deletes a person's raw rows; the rollups
have nothing about them to erase. **Consent**: cookieless by default; the
cookie `_rp` (one year, SameSite=Lax, Secure) appears only after the person
accepts, or under the `always` mode a host chooses knowingly.
