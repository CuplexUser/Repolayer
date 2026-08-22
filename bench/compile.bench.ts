import { bench, describe } from 'vitest';

import { defineSchema } from '../src/core/schema.js';
import { compileCount, compileSelect, selectList, type QueryOptions } from '../src/core/query.js';

/**
 * Query compilation happens once per call, on every call. It is pure string work with no
 * IO, so it is the part of a query the package is entirely responsible for.
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

const empty: QueryOptions<Row> = {};

const threeFilters: QueryOptions<Row> = {
  where: [
    { field: 'active', op: 'eq', value: true },
    { field: 'quantity', op: 'gte', value: 5 },
    { field: 'name', op: 'like', value: 'A%' },
  ],
  orderBy: [{ field: 'createdAt', direction: 'desc' }],
  limit: 20,
  offset: 40,
};

const tenFilters: QueryOptions<Row> = {
  where: [
    { field: 'active', op: 'eq', value: true },
    { field: 'quantity', op: 'gte', value: 5 },
    { field: 'quantity', op: 'lte', value: 500 },
    { field: 'weight', op: 'gt', value: 0.5 },
    { field: 'name', op: 'like', value: 'A%' },
    { field: 'slug', op: 'ilike', value: 'anvil%' },
    { field: 'slug', op: 'in', value: ['a', 'b', 'c', 'd'] },
    { field: 'id', op: 'nin', value: ['x', 'y'] },
    { field: 'meta', op: 'isNull', value: false },
    { field: 'releasedAt', op: 'lt', value: new Date('2024-01-01T00:00:00.000Z') },
  ],
  orderBy: [
    { field: 'releasedAt', direction: 'asc' },
    { field: 'name', direction: 'desc' },
  ],
  limit: 50,
};

for (const dialect of ['sqlite', 'postgres'] as const) {
  describe(`compileSelect (${dialect})`, () => {
    bench('no filters', () => {
      compileSelect<Row>(schema, 'widgets', empty, dialect);
    });

    bench('three filters, order, limit, offset', () => {
      compileSelect<Row>(schema, 'widgets', threeFilters, dialect);
    });

    bench('ten filters, two sort keys', () => {
      compileSelect<Row>(schema, 'widgets', tenFilters, dialect);
    });
  });
}

describe('compileCount', () => {
  bench('three filters', () => {
    compileCount<Row>(schema, 'widgets', threeFilters, 'postgres');
  });
});

describe('selectList', () => {
  bench('ten columns', () => {
    selectList(schema);
  });
});
