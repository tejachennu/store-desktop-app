import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // All server test files share one PostgreSQL test database.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
