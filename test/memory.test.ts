import { MemoryRepo, MemoryStore } from '../src/testing/memory.js';
import { runConformanceSuite, type ConformanceRepoOptions } from '../src/testing/index.js';
import type { Repo } from '../src/core/repo.js';

// One store for the whole suite, the way the SQLite run shares one connection, so
// `with(ctx)` exercises the shared-state path two repos actually use. Tables are unique
// per test.
const store = new MemoryStore();

runConformanceSuite({
  name: 'memory',
  async createRepo<T>(options: ConformanceRepoOptions): Promise<Repo<T>> {
    const repo = new MemoryRepo<T>({
      table: options.table,
      schema: options.schema,
      store,
      ids: options.ids ?? 'uuid',
      timestamps: options.timestamps ? { createdAt: 'createdAt', updatedAt: 'updatedAt' } : {},
    });
    await repo.ensureTable();
    return repo;
  },
  async cleanup() {
    store.clear();
  },
});
