import { describe, it } from 'vitest';

import { MysqlConnection, MysqlRepo } from '../src/mysql/index.js';
import { runConformanceSuite, type ConformanceRepoOptions } from '../src/testing/index.js';
import type { Repo } from '../src/core/repo.js';

/**
 * Shared driver for the MySQL and MariaDB conformance runs.
 *
 * One adapter serves both servers, so both get the identical suite against a live server
 * and any difference between them shows up as a failure rather than as a subtly different
 * test file. The only thing that varies is which URL to connect to.
 */
export async function runMysqlConformance(
  name: string,
  envVar: string,
  url: string | undefined,
): Promise<void> {
  if (!url) {
    // Skipping loudly beats skipping silently: `npm test` should work with zero setup, but
    // it should also say what it did not check.
    describe(`conformance: ${name}`, () => {
      it.skip(`needs ${envVar} (try: npm run test:${name}, which starts docker compose)`, () => {
        /* intentionally skipped */
      });
    });
    return;
  }

  const connection = await MysqlConnection.create({ connectionString: url });
  const created: string[] = [];

  runConformanceSuite({
    name: `${name} (${connection.flavor})`,
    async createRepo<T>(options: ConformanceRepoOptions): Promise<Repo<T>> {
      const repo = new MysqlRepo<T>({
        table: options.table,
        schema: options.schema,
        connection,
        ids: options.ids ?? 'uuid',
        timestamps: options.timestamps ? { createdAt: 'createdAt', updatedAt: 'updatedAt' } : {},
      });
      await repo.ensureTable();
      created.push(options.table);
      return repo;
    },
    async cleanup() {
      for (const table of created) {
        await connection.pool.query(`DROP TABLE IF EXISTS ${table}`);
      }
      await connection.end();
    },
  });
}
