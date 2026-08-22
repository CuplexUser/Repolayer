import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'sqlite/index': 'src/sqlite/index.ts',
    'postgres/index': 'src/postgres/index.ts',
    'mysql/index': 'src/mysql/index.ts',
    'memory/index': 'src/testing/memory.ts',
    'testing/index': 'src/testing/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  // tsdown defaults ESM output to .mjs/.d.mts. The published export map points at
  // dist/index.js and dist/index.d.ts, and those paths are part of what consumers have
  // already resolved, so the extensions are pinned here rather than churned.
  outExtensions: ({ format }) => (format === 'es' ? { js: '.js', dts: '.d.ts' } : undefined),
  clean: true,
  target: 'node22',
  // `pg`, `mysql2`, and `vitest` are optional peer deps and `node:sqlite` is a builtin.
  // Bundling
  // any of them would ship a copy of someone else's package inside this one.
  external: ['pg', 'mysql2', 'mysql2/promise', 'vitest', 'node:sqlite'],
});
