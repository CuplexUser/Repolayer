import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SqliteRepo, openSqlite } from '../src/sqlite/index.js';
import { runConformanceSuite, type ConformanceRepoOptions } from '../src/testing/index.js';
import type { Repo } from '../src/core/repo.js';

// One file-backed database for the whole suite, so transactions and `with(ctx)` exercise
// the same shared-connection path a real app uses. Tables are unique per test.
const dir = mkdtempSync(path.join(tmpdir(), 'repolayer-'));
const file = path.join(dir, 'conformance.db');
const connection = openSqlite({ file });

runConformanceSuite({
  name: 'sqlite',
  async createRepo<T>(options: ConformanceRepoOptions): Promise<Repo<T>> {
    const repo = new SqliteRepo<T>({
      table: options.table,
      schema: options.schema,
      connection,
      ids: options.ids ?? 'uuid',
      timestamps: options.timestamps ? { createdAt: 'createdAt', updatedAt: 'updatedAt' } : {},
    });
    await repo.ensureTable();
    return repo;
  },
  async cleanup() {
    connection.close();
    rmSync(dir, { recursive: true, force: true });
  },
});
