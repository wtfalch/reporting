import { fileURLToPath } from 'node:url';
import { migrationsDir as coreMigrationsDir } from '@wtfalch/reporting-core/migrations-dir';

/**
 * The directory holding this package's own `NNNN_<name>.sql` files:
 * `src/migrations` in development, `dist/migrations` once built.
 *
 * Its own subpath (`@wtfalch/reporting-service/migrations-dir`) and no other
 * imports than `node:url` and core's own `migrations-dir`, which imports
 * `node:url` only: a
 * migration image loads this without Drizzle or zod.
 */
export const migrationsDir: string = fileURLToPath(new URL('./migrations/', import.meta.url));

/**
 * What a host passes to `runMigrationSources` from `@wtfalch/db/migrate`:
 * core's migrations first, this package's after them, each under its own
 * ledger name so the two `0001_*.sql` never meet. The tables here refer to
 * none of core's, but the order is the contract (docs/plans/backend.md).
 */
export const migrationSources: readonly { readonly name: string; readonly dir: string }[] = [
  { name: 'reporting', dir: coreMigrationsDir },
  { name: 'reporting-service', dir: migrationsDir },
];
