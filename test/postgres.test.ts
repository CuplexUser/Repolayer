import { describe, it } from 'vitest';

import { PostgresConnection, PostgresRepo } from '../src/postgres/index.js';
import { runConformanceSuite, type ConformanceRepoOptions } from '../src/testing/index.js';
import type { Repo } from '../src/core/repo.js';

const url = process.env['TEST_DATABASE_URL'];

if (!url) {
  // Skipping loudly beats skipping silently: `npm test` should work with zero setup, but
  // it should also say what it did not check.
  describe('conformance: postgres', () => {
    it.skip('needs TEST_DATABASE_URL (try: npm run test:pg, which starts docker compose)', () => {
      /* intentionally skipped */
    });
  });
} else {
  const connection = await PostgresConnection.create({ connectionString: url });
  const created: string[] = [];

  runConformanceSuite({
    name: 'postgres',
    async createRepo<T>(options: ConformanceRepoOptions): Promise<Repo<T>> {
      const repo = new PostgresRepo<T>({
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
    // pg's Pool exposes its counts, which is what lets the cursor cases prove an early
    // break does not leak a checked-out client.
    busyConnections() {
      const pool = connection.pool as unknown as { totalCount: number; idleCount: number };
      return pool.totalCount - pool.idleCount;
    },
    async cleanup() {
      for (const table of created) {
        await connection.pool.query(`DROP TABLE IF EXISTS ${table}`);
      }
      await connection.end();
    },
  });
}
