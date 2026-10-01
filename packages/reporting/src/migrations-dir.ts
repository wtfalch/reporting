import { fileURLToPath } from 'node:url';

/**
 * Absolute path of the directory holding this package's numbered `.sql`
 * migrations. The host passes it to `runMigrationSources` as
 * `{ name: 'reporting', dir: migrationsDir }`.
 *
 * Its own subpath (`@wtfalch/reporting/migrations-dir`) and no other
 * imports: a migration image imports this without the Drizzle, React and
 * Next the main entry pulls in, and a bundler never meets this file's
 * `import.meta.url` through the main entry.
 */
export const migrationsDir = fileURLToPath(new URL('./migrations/', import.meta.url));
