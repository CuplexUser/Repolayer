import { bench, describe } from 'vitest';

import { defineSchema } from '../src/core/schema.js';
import { fromDb, rowToEntity, toDb } from '../src/core/serialize.js';

/**
 * Row mapping is the hottest path in the package: every returned row goes through it once
 * per field, on every read, on every engine. These benchmarks exist so a change there is
 * judged by a number rather than by how it reads.
 */

const schema = defineSchema({
  id: { type: 'string', primaryKey: true },
  name: { type: 'string' },
  slug: { type: 'string', unique: true },
  quantity: { type: 'integer' },
  weight: { type: 'number' },
  active: { type: 'boolean' },
  meta: { type: 'json', nullable: true },
  releasedAt: { type: 'date', nullable: true, column: 'released_at' },
  createdAt: { type: 'date', column: 'created_at' },
  updatedAt: { type: 'date', column: 'updated_at' },
});

const now = new Date('2024-05-06T07:08:09.123Z');

const sqliteRow: Record<string, unknown> = {
  id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  name: 'Anvil',
  slug: 'anvil-1',
  quantity: 42,
  weight: 1.5,
  active: 1,
  meta: '{"tags":["a","b"],"nested":{"n":1}}',
  released_at: now.toISOString(),
  created_at: now.toISOString(),
  updated_at: now.toISOString(),
};

const postgresRow: Record<string, unknown> = {
  id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  name: 'Anvil',
  slug: 'anvil-1',
  quantity: '42',
  weight: 1.5,
  active: true,
  meta: { tags: ['a', 'b'], nested: { n: 1 } },
  released_at: now,
  created_at: now,
  updated_at: now,
};

const batch = Array.from({ length: 100 }, () => sqliteRow);

describe('rowToEntity', () => {
  bench('one sqlite row, 10 fields', () => {
    rowToEntity(sqliteRow, schema, 'sqlite');
  });

  bench('one postgres row, 10 fields', () => {
    rowToEntity(postgresRow, schema, 'postgres');
  });

  bench('100 sqlite rows', () => {
    for (const row of batch) rowToEntity(row, schema, 'sqlite');
  });
});

describe('toDb', () => {
  bench('string', () => {
    toDb('Anvil', 'string', 'sqlite', 'name');
  });

  bench('integer', () => {
    toDb(42, 'integer', 'sqlite', 'quantity');
  });

  bench('boolean', () => {
    toDb(true, 'boolean', 'sqlite', 'active');
  });

  bench('date', () => {
    toDb(now, 'date', 'sqlite', 'createdAt');
  });

  bench('json', () => {
    toDb({ tags: ['a', 'b'], nested: { n: 1 } }, 'json', 'sqlite', 'meta');
  });
});

describe('fromDb', () => {
  bench('integer from a postgres bigint string', () => {
    fromDb('42', 'integer', 'postgres', 'quantity');
  });

  bench('date from a sqlite iso string', () => {
    fromDb(now.toISOString(), 'date', 'sqlite', 'createdAt');
  });

  bench('json from sqlite text', () => {
    fromDb('{"tags":["a","b"],"nested":{"n":1}}', 'json', 'sqlite', 'meta');
  });
});
