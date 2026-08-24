import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Integration tests share one MongoDB replica set and clear collections between
    // files, so they must not run in parallel across worker processes.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true, isolate: false } },
    hookTimeout: 120_000,
    testTimeout: 60_000,
    sequence: { concurrent: false },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/cli/**', 'src/docs/**'],
    },
  },
});
