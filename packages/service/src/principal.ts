import type { Actor } from '@wtfalch/reporting-core';

/**
 * This package's own vocabulary, not `@wtfalch/authz`'s resource catalogue:
 * one company runs one reporting backend for itself (no cross-organisation
 * resource scoping to express), so the only question a route asks is
 * "may this caller do this kind of thing at all". `ingest` covers the three
 * write-and-forget routes (events, errors, request counts); `resolve` is
 * split out from `read` because moving an error's triage state is a
 * decision, not a view; `settings` covers both reading and changing the
 * site-wide and tenant-scoped settings, since an operator who may change
 * them needs to see them first; `release-health` is its own permission
 * because it is meant for foundry's own release judging, a different
 * caller than a normal reporting client.
 */
export type Permission =
  | 'reporting:ingest'
  | 'reporting:read'
  | 'reporting:resolve'
  | 'reporting:settings'
  | 'reporting:release-health';

/**
 * What the data service host resolves from a caller's token before it ever
 * reaches a handler here (see the package README): who is making the
 * request, for the `actor` stamped on anything this package audits, and
 * what it may do. A handler never builds one itself and never reads a
 * token -- `null` is how the host says "no valid credential".
 */
export interface ReportingPrincipal {
  readonly actor: Actor;
  readonly permissions: ReadonlySet<Permission>;
}

export function principalAllows(
  principal: ReportingPrincipal | null,
  permission: Permission,
): boolean {
  return principal === null ? false : principal.permissions.has(permission);
}
