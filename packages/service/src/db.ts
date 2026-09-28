/**
 * Values are bound parameters. Implementations must keep a transaction on one
 * connection.
 *
 * This is deliberately a structural interface and not a dependency on
 * `@wtfalch/db`. A `Database` from that package already satisfies it, so the
 * host injects one and the published package still declares no dependencies
 * (package-template ADR 0003, package-template ADR 0004). The server version is the host's to choose for the
 * same reason -- db owns queries and transactions, never provisioning.
 */
export interface Queryable {
  query<T extends Record<string, unknown>>(text: string, values?: unknown[]): Promise<T[]>;
}
export interface Database extends Queryable {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
}
