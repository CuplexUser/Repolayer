import { bench, describe } from 'vitest';

import { defineSchema } from '../src/core/schema.js';
import { SqliteRepo, openSqlite } from '../src/sqlite/index.js';

/**
 * End to end through a real engine, on an in-memory database so the numbers reflect the
 * package rather than the disk. SQLite is the right subject: `node:sqlite` is synchronous,
 * so almost everything measured here is repolayer's own work.
 */

const schema = defineSchema({
  id: { type: 'string', primaryKey: true },
  name: { type: 'string' },
  slug: { type: 'string' },
  quantity: { type: 'integer' },
  weight: { type: 'number' },
  active: { type: 'boolean' },
  meta: { type: 'json', nullable: true },
  releasedAt: { type: 'date', nullable: true, column: 'released_at' },
  createdAt: { type: 'date', column: 'created_at' },
  updatedAt: { type: 'date', column: 'updated_at' },
});

interface Row {
  id: string;
  name: string;
  slug: string;
  quantity: number;
  weight: number;
  active: boolean;
  meta: unknown | null;
  releasedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const connection = openSqlite({ file: ':memory:' });

function repoOn(table: string): SqliteRepo<Row> {
  return new SqliteRepo<Row>({
    table,
    schema,
    connection,
    ids: 'uuid',
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  });
}

const row = (i: number): Partial<Row> => ({
  name: `Widget ${i}`,
  slug: `widget-${i}`,
  quantity: i,
  weight: i / 3,
  active: i % 2 === 0,
  meta: { i, tags: ['a', 'b'] },
  releasedAt: i % 3 === 0 ? null : new Date(1_700_000_000_000 + i),
});

// One table of 1000 rows for the read benchmarks, so every read measures the same shape.
const reads = repoOn('bench_reads');
await reads.ensureTable();
await reads.deleteMany();
await reads.createMany(Array.from({ length: 1000 }, (_, i) => row(i)));
const anId = (await reads.findOne())?.id as string;

const writes = repoOn('bench_writes');
await writes.ensureTable();

describe('sqlite reads', () => {
  bench('findById', async () => {
    await reads.findById(anId);
  });

  bench('findOne with a filter', async () => {
    await reads.findOne({ where: [{ field: 'slug', op: 'eq', value: 'widget-500' }] });
  });

  bench('findMany, 1000 rows', async () => {
    await reads.findMany();
  });

  bench('findMany, 50 rows filtered and ordered', async () => {
    await reads.findMany({
      where: [
        { field: 'active', op: 'eq', value: true },
        { field: 'quantity', op: 'gte', value: 100 },
      ],
      orderBy: [{ field: 'quantity', direction: 'desc' }],
      limit: 50,
    });
  });

  bench('count with a filter', async () => {
    await reads.count({ where: [{ field: 'active', op: 'eq', value: true }] });
  });
});

let counter = 0;

describe('sqlite writes', () => {
  bench('create', async () => {
    counter += 1;
    await writes.create(row(counter));
  });

  bench('createMany, 100 rows', async () => {
    counter += 1;
    await writes.createMany(Array.from({ length: 100 }, (_, i) => row(counter * 1000 + i)));
  });

  bench('withTransaction, one create', async () => {
    counter += 1;
    await writes.withTransaction(async (tx) => tx.create(row(counter)));
  });
});
