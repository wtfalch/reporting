import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Applying core's and the service's migrations to a fresh PGlite takes
// several seconds under load, beyond vitest's 5 s default.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
