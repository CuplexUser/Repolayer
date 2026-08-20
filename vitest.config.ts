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
    // Each SQLite conformance run uses its own database file and each test its own table,
    // so files can run in parallel safely.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
