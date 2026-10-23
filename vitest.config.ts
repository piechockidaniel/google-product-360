import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['server/src/**/*.ts'],
      exclude: ['server/src/index.ts', 'server/src/cli/**', 'server/src/util/create-logger.ts', 'server/src/google/types.ts'],
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
});
