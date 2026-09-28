import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // PGlite's WASM boot and a real Postgres connection (TEST_DATABASE_URL)
    // are both slower than the default 5s under load.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
