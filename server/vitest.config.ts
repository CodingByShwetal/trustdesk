import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://trustdesk:trustdesk@localhost:5432/trustdesk_test',
      LLM_PROVIDER: 'mock',
      NODE_ENV: 'test',
      REPORTS_DIR: '/tmp/trustdesk-test-reports',
    },
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
