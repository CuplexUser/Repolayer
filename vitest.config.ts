import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // `node:sqlite` is a prefix-only builtin and is absent from `module.builtinModules`,
      // so Vite does not treat it as external and fails trying to load a file called
      // "sqlite". The shim re-exports it through createRequire. Test-time only: the
      // published build keeps the real `node:sqlite` import.
      'node:sqlite': fileURLToPath(new URL('./test/shims/node-sqlite.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    benchmark: {
      include: ['bench/**/*.bench.ts'],
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'lcov'],
      // Thresholds are a ratchet, not an aspiration: raise them when coverage rises,
      // never lower them to make a run pass.
      // Set just under what a local run (no Postgres, no MySQL) achieves, so `npm test`
      // stays runnable with zero setup. CI runs every engine and clears these easily.
      thresholds: {
        lines: 94,
        functions: 94,
        branches: 84,
        statements: 93,
      },
    },
    // Each SQLite conformance run uses its own database file and each test its own table,
    // so files can run in parallel safely.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
