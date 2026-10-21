import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // e2e tests share one PostgreSQL database.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: {
      TEST_DATABASE_URL: process.env.TEST_E2E_DATABASE_URL ?? 'postgres://store:store@localhost:5432/store_test_e2e',
    },
    globalSetup: ['test/global-setup.ts'],
  },
});
