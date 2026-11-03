import type { RunMigrationSourcesOptions, RunMigrationSourcesResult } from '@wtfalch/db/migrate';
import { runMigrationSources } from '@wtfalch/db/migrate';
import { migrationsDir } from '@wtfalch/reporting-core/migrations-dir';

/** Every host runs the schema under this name; it is never configurable, so two companies' own databases stay comparable and a Dockerfile never needs to pass it in. */
export const REPORTING_SCHEMA = 'reporting';

export type MigrateOptions = Omit<RunMigrationSourcesOptions, 'sources' | 'schema'>;

/**
 * Applies `@wtfalch/reporting-core`'s own migrations (`packages/reporting/
 * src/migrations/0001..0011`) into schema `reporting`, through
 * `@wtfalch/db`'s multi-source runner -- the same mechanism every other
 * package-template-shaped repo's host uses. Idempotent: a host calls this
 * on boot, every boot. Either `url` or `owner` (exactly one, same as
 * `runMigrationSources` itself); never both.
 */
export async function migrate(options: MigrateOptions): Promise<RunMigrationSourcesResult> {
  return runMigrationSources({
    ...options,
    schema: REPORTING_SCHEMA,
    sources: [{ name: 'reporting', dir: migrationsDir }],
  });
}
