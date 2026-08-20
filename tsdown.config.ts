import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'sqlite/index': 'src/sqlite/index.ts',
    'postgres/index': 'src/postgres/index.ts',
    'testing/index': 'src/testing/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'node22',
  // `pg` and `vitest` are optional peer deps and `node:sqlite` is a builtin. Bundling
  // any of them would ship a copy of someone else's package inside this one.
  external: ['pg', 'vitest', 'node:sqlite'],
});
