import { describe, expect, it } from 'vitest';

import {
  aggregateRow,
  compileAggregate,
  compileDistinct,
  planAggregate,
  type AggregateQuery,
} from '../../src/core/aggregate.js';
import type { Dialect } from '../../src/core/dialect.js';
import { QueryError } from '../../src/core/errors.js';
import type { QueryOptions } from '../../src/core/query.js';
import { defineSchema } from '../../src/core/schema.js';

/**
 * Compiler-level tests for grouping and distinct reads. Like the rest of the unit tests
 * these need no database, which is the only way to assert on the Postgres and MySQL SQL
 * without a live server for each.
 */

const schema = defineSchema({
  id: { type: 'string', primaryKey: true },
  name: { type: 'string' },
  quantity: { type: 'integer' },
  weight: { type: 'number' },
  active: { type: 'boolean' },
  meta: { type: 'json', nullable: true },
  releasedAt: { type: 'date', nullable: true, column: 'released_at' },
});

interface Row {
  id: string;
  name: string;
  quantity: number;
  weight: number;
  active: boolean;
  meta: unknown | null;
  releasedAt: Date | null;
}

const compile = (query: AggregateQuery<Row>, dialect: Dialect) =>
  compileAggregate<Row>(schema, 'widgets', query, dialect);

const distinct = (
  fields: (keyof Row & string)[],
  query: QueryOptions<Row> | undefined,
  dialect: Dialect,
) => compileDistinct<Row>(schema, 'widgets', fields, query, dialect);

describe('compileAggregate', () => {
  it('reduces the whole table when there is no groupBy', () => {
    const { sql, params } = compile({ aggregates: { total: { fn: 'count' } } }, 'sqlite');
    expect(sql).toBe('SELECT COUNT(*) AS total FROM widgets');
    expect(params).toEqual([]);
  });

  it('projects the group columns before the aggregates, and groups by column name', () => {
    const { sql } = compile(
      {
        groupBy: ['name', 'releasedAt'],
        aggregates: { tally: { fn: 'count' }, total: { fn: 'sum', field: 'quantity' } },
      },
      'sqlite',
    );
    expect(sql).toBe(
      'SELECT name, released_at, COUNT(*) AS tally, SUM(quantity) AS total ' +
        'FROM widgets GROUP BY name, released_at',
    );
  });

  it('averages in double precision on every engine, so the answers agree', () => {
    const query: AggregateQuery<Row> = { aggregates: { mean: { fn: 'avg', field: 'quantity' } } };

    expect(compile(query, 'sqlite').sql).toContain('AVG(quantity) AS mean');
    expect(compile(query, 'postgres').sql).toContain(
      'AVG(CAST(quantity AS DOUBLE PRECISION)) AS mean',
    );
    // Adding a double literal is what stops MySQL answering as a four-place DECIMAL.
    expect(compile(query, 'mysql').sql).toContain('AVG(quantity + 0e0) AS mean');
  });

  it('renders a distinct aggregate as DISTINCT inside the call', () => {
    const { sql } = compile(
      {
        aggregates: {
          names: { fn: 'count', field: 'name', distinct: true },
          total: { fn: 'sum', field: 'quantity', distinct: true },
        },
      },
      'sqlite',
    );
    expect(sql).toContain('COUNT(DISTINCT name) AS names');
    expect(sql).toContain('SUM(DISTINCT quantity) AS total');
  });

  it('repeats the aggregate expression in HAVING rather than naming the alias', () => {
    // Postgres accepts an output name in GROUP BY and ORDER BY but not in HAVING, so the
    // expression is the one spelling every engine reads the same way.
    const { sql, params } = compile(
      {
        where: [{ field: 'active', op: 'eq', value: true }],
        groupBy: ['name'],
        aggregates: { tally: { fn: 'count' } },
        having: [{ alias: 'tally', op: 'gte', value: 2 }],
        limit: 10,
      },
      'postgres',
    );

    expect(sql).toBe(
      'SELECT name, COUNT(*) AS tally FROM widgets WHERE active = $1 ' +
        'GROUP BY name HAVING COUNT(*) >= $2 LIMIT $3',
    );
    // Bound in clause order, which is the order the engine expects them in.
    expect(params).toEqual([true, 2, 10]);
  });

  it('keeps a null aggregate inside having ne, exactly as ne does on a column', () => {
    const { sql } = compile(
      {
        groupBy: ['name'],
        aggregates: { total: { fn: 'sum', field: 'quantity' } },
        having: [{ alias: 'total', op: 'ne', value: 5 }],
      },
      'sqlite',
    );
    expect(sql).toContain('HAVING (SUM(quantity) <> ? OR SUM(quantity) IS NULL)');
  });

  it('reads an isNull having as a null test with no parameter', () => {
    const { sql, params } = compile(
      {
        groupBy: ['name'],
        aggregates: { earliest: { fn: 'min', field: 'releasedAt' } },
        having: [{ alias: 'earliest', op: 'isNull', value: false }],
      },
      'sqlite',
    );
    expect(sql).toContain('HAVING MIN(released_at) IS NOT NULL');
    expect(params).toEqual([]);
  });

  it('binds a having value the way its aggregate reads back', () => {
    const date = new Date('2024-03-05T06:07:08.000Z');
    const query: AggregateQuery<Row> = {
      aggregates: { earliest: { fn: 'min', field: 'releasedAt' } },
      having: [{ alias: 'earliest', op: 'gte', value: date }],
    };

    // A min over a date column is still a date, so the bound value is serialized as one.
    expect(compile(query, 'sqlite').params).toEqual(['2024-03-05T06:07:08.000Z']);
    expect(compile(query, 'mysql').params).toEqual(['2024-03-05 06:07:08.000']);
    expect(compile(query, 'postgres').params).toEqual([date]);
  });

  it('states the null position when ordering a group, on every engine', () => {
    const query: AggregateQuery<Row> = {
      groupBy: ['releasedAt'],
      aggregates: { tally: { fn: 'count' } },
      orderBy: [{ field: 'releasedAt', direction: 'asc' }],
    };

    expect(compile(query, 'sqlite').sql).toContain('ORDER BY released_at ASC NULLS LAST');
    expect(compile(query, 'postgres').sql).toContain('ORDER BY released_at ASC NULLS LAST');
    // MySQL has no NULLS LAST, so the same position comes from sorting on the nullness.
    expect(compile(query, 'mysql').sql).toContain(
      'ORDER BY (released_at IS NULL) ASC, released_at ASC',
    );
  });

  it('orders by an aggregate through its expression, not its alias', () => {
    const query: AggregateQuery<Row> = {
      groupBy: ['name'],
      aggregates: { tally: { fn: 'count' } },
      orderBy: [{ field: 'tally', direction: 'desc' }],
    };

    expect(compile(query, 'sqlite').sql).toContain('ORDER BY COUNT(*) DESC NULLS FIRST');
    expect(compile(query, 'mysql').sql).toContain(
      'ORDER BY (COUNT(*) IS NULL) DESC, COUNT(*) DESC',
    );
  });

  it('pages the groups rather than the rows', () => {
    const { sql, params } = compile(
      { groupBy: ['name'], aggregates: { tally: { fn: 'count' } }, limit: 2, offset: 4 },
      'sqlite',
    );
    expect(sql).toContain('GROUP BY name LIMIT ? OFFSET ?');
    expect(params).toEqual([2, 4]);
  });

  it('groups with no aggregates at all', () => {
    const { sql } = compile({ groupBy: ['name'], aggregates: {} }, 'sqlite');
    expect(sql).toBe('SELECT name FROM widgets GROUP BY name');
  });
});

describe('aggregate validation', () => {
  const rejects =
    (query: AggregateQuery<Row>): (() => unknown) =>
    () =>
      planAggregate<Row>(schema, query);

  it('rejects an aggregate the engines would answer differently', () => {
    expect(rejects({ aggregates: { x: { fn: 'sum', field: 'name' } } })).toThrow(QueryError);
    expect(rejects({ aggregates: { x: { fn: 'avg', field: 'active' } } })).toThrow(QueryError);
    expect(rejects({ aggregates: { x: { fn: 'max', field: 'meta' } } })).toThrow(
      /no engine-independent ordering of a json value/,
    );
    // Postgres has no min(boolean) at all, so the query is refused before it is sent.
    expect(rejects({ aggregates: { x: { fn: 'min', field: 'active' } } })).toThrow(QueryError);
    expect(rejects({ groupBy: ['meta'], aggregates: { x: { fn: 'count' } } })).toThrow(QueryError);
    expect(rejects({ aggregates: { x: { fn: 'count', field: 'meta', distinct: true } } })).toThrow(
      QueryError,
    );
  });

  it('rejects a distinct min or max, which cannot mean anything', () => {
    expect(
      rejects({ aggregates: { x: { fn: 'min', field: 'quantity', distinct: true } } }),
    ).toThrow(/cannot mean anything/);
  });

  it('rejects an aggregate with no field, other than count over rows', () => {
    expect(rejects({ aggregates: { x: { fn: 'sum' } } })).toThrow(/needs a field/);
    expect(rejects({ aggregates: { x: { fn: 'count', distinct: true } } })).toThrow(
      /distinct count with no field/,
    );
  });

  it('rejects an alias that is not a plain identifier', () => {
    // Aliases are interpolated into the statement, so they are held to the same shape a
    // column name is, and for the same reason.
    expect(rejects({ aggregates: { 'total; DROP TABLE widgets': { fn: 'count' } } })).toThrow(
      /plain identifier/,
    );
  });

  it('rejects two names that differ only in case, which Postgres would fold together', () => {
    expect(
      rejects({ aggregates: { total: { fn: 'count' }, TOTAL: { fn: 'sum', field: 'quantity' } } }),
    ).toThrow(/differ by more than case/);
    expect(rejects({ groupBy: ['name'], aggregates: { NAME: { fn: 'count' } } })).toThrow(
      /differ by more than case/,
    );
  });

  it('rejects a groupBy that names one field twice', () => {
    expect(rejects({ groupBy: ['name', 'name'], aggregates: { x: { fn: 'count' } } })).toThrow(
      /named twice/,
    );
  });

  it('rejects an empty query, a having on a column, and an order by nothing', () => {
    expect(rejects({ aggregates: {} })).toThrow(/at least one aggregate/);
    expect(
      rejects({
        aggregates: { tally: { fn: 'count' } },
        having: [{ alias: 'quantity', op: 'gt', value: 1 }],
      }),
    ).toThrow(/belongs in where/);
    expect(
      rejects({
        aggregates: { tally: { fn: 'count' } },
        orderBy: [{ field: 'quantity', direction: 'asc' }],
      }),
    ).toThrow(/neither a groupBy field nor an aggregate alias/);
  });
});

describe('aggregateRow', () => {
  const plan = planAggregate<Row>(schema, {
    groupBy: ['releasedAt'],
    aggregates: {
      tally: { fn: 'count' },
      total: { fn: 'sum', field: 'quantity' },
      mean: { fn: 'avg', field: 'quantity' },
      heaviest: { fn: 'max', field: 'weight' },
    },
  });

  it('reads a Postgres bigint count and numeric sum back as numbers', () => {
    const row = aggregateRow(
      {
        released_at: new Date('2024-03-05T06:07:08.000Z'),
        tally: '3',
        total: '18',
        mean: 6,
        heaviest: 4.5,
      },
      plan,
      'postgres',
    );
    expect(row).toEqual({
      releasedAt: new Date('2024-03-05T06:07:08.000Z'),
      tally: 3,
      total: 18,
      mean: 6,
      heaviest: 4.5,
    });
  });

  it('finds an alias Postgres folded to lower case', () => {
    const folded = planAggregate<Row>(schema, {
      aggregates: { totalQuantity: { fn: 'sum', field: 'quantity' } },
    });
    expect(aggregateRow({ totalquantity: '7' }, folded, 'postgres')).toEqual({ totalQuantity: 7 });
  });

  it('keeps an aggregate over no rows null, but never a count', () => {
    const row = aggregateRow(
      { released_at: null, tally: 0, total: null, mean: null, heaviest: null },
      plan,
      'sqlite',
    );
    expect(row).toEqual({ releasedAt: null, tally: 0, total: null, mean: null, heaviest: null });
  });
});

describe('compileDistinct', () => {
  it('selects the named columns once each', () => {
    const { sql, params } = distinct(['name', 'quantity'], undefined, 'sqlite');
    expect(sql).toBe('SELECT DISTINCT name, quantity FROM widgets');
    expect(params).toEqual([]);
  });

  it('applies where, orderBy, limit, and offset', () => {
    const { sql, params } = distinct(
      ['name'],
      {
        where: [{ field: 'active', op: 'eq', value: true }],
        orderBy: [{ field: 'name', direction: 'desc' }],
        limit: 5,
      },
      'postgres',
    );
    expect(sql).toBe(
      'SELECT DISTINCT name FROM widgets WHERE active = $1 ORDER BY name DESC NULLS FIRST LIMIT $2',
    );
    expect(params).toEqual([true, 5]);
  });

  it('refuses to order by a column it does not select', () => {
    // Postgres rejects this outright and SQLite answers it with an arbitrary row per
    // group, so the only portable answer is to refuse it everywhere.
    expect(() =>
      distinct(['name'], { orderBy: [{ field: 'quantity', direction: 'asc' }] }, 'sqlite'),
    ).toThrow(/not one of the fields it selects/);
  });

  it('refuses a json field and an empty field list', () => {
    expect(() => distinct(['meta'], undefined, 'sqlite')).toThrow(QueryError);
    expect(() => distinct([], undefined, 'sqlite')).toThrow(/at least one field/);
  });
});
