import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // integration tests spawn compiled entries: keep generous but bounded timeouts
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
