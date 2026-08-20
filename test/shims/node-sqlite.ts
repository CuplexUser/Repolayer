/**
 * Test-only shim for `node:sqlite`.
 *
 * `node:sqlite` is a prefix-only builtin: it is absent from `module.builtinModules`, so
 * Vite does not recognize it and tries to resolve a file named "sqlite". Going through
 * `createRequire` hands the import straight to Node and bypasses Vite's resolver.
 *
 * The library source keeps the plain `import ... from 'node:sqlite'`, which is what ships:
 * this alias applies only under vitest.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sqlite = require('node:sqlite') as { DatabaseSync: unknown };

export const DatabaseSync = sqlite.DatabaseSync as new (
  path: string,
  options?: unknown,
) => unknown;
