import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    env: {
      // Tests must never inherit a live configuration from the shell.
      DRY_RUN: 'true',
      LIVE_CONFIRM: '',
    },
  },
});
