import { defineConfig } from 'vitest/config';

// With TEST_DATABASE_URL set the files share one real database, so they run
// one at a time; on PGlite every file has a database of its own. Applying
// core's eleven migrations and this package's own to a fresh PGlite takes a
// few seconds under load, and `beforeAll` is bound by hookTimeout.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    fileParallelism: !process.env.TEST_DATABASE_URL,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
