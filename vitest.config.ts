import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    // Integration tests share one database.
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/slotwise_test',
      JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
      AI_PROVIDER: 'mock',
      MISTRAL_API_KEY: '',
      CORS_ORIGINS: 'http://localhost:3000',
    },
  },
});
