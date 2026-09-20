import { defineConfig } from 'vitest/config';

// With TEST_DATABASE_URL set the files share one real database, so they run
// one at a time; on PGlite every file has a database of its own.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    fileParallelism: !process.env.TEST_DATABASE_URL,
    testTimeout: 30_000,
    // `beforeAll` calling `testDb()` is a HOOK, so it is bound by
    // hookTimeout, not testTimeout, and vitest's default for that is 10s.
    // Applying a third migration to a fresh PGlite, several files at once,
    // crosses it; the three database-heavy files then fail on setup while
    // passing when run alone. Same budget as a test.
    hookTimeout: 30_000,
  },
});
