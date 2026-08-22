import { describe, expect, it } from 'vitest';

import { QueryError } from '../../src/core/errors.js';
import {
  decodeCursor,
  encodeCursor,
  keysetFilter,
  resolveSortKeys,
} from '../../src/core/keyset.js';
import { compileSelect, type OrderBy } from '../../src/core/query.js';
import { defineSchema } from '../../src/core/schema.js';

/**
 * Keyset paging, checked at the compiler level.
 *
 * The conformance suite proves the walk is correct against a live engine, but only for the
 * engines a given machine can reach. These cases pin the generated predicate itself, which
 * is where the null handling and the mixed-direction expansion actually live, and they run
 * everywhere with no database at all.
 */

const schema = defineSchema({
  id: { type: 'string', primaryKey: true },
  name: { type: 'string' },
  quantity: { type: 'integer' },
  releasedAt: { type: 'date', nullable: true, column: 'released_at' },
  meta: { type: 'json', nullable: true },
});

interface Row {
  id: string;
  name: string;
  quantity: number;
  releasedAt: Date | null;
  meta: unknown | null;
}

/** Compiles just the keyset predicate, so the assertions read as SQL. */
const predicate = (keys: OrderBy<Row>[], values: unknown[]): string => {
  const { sql } = compileSelect<Row>(
    schema,
    't',
    { where: [keysetFilter(keys, values)] },
    'sqlite',
  );
  return sql.slice(sql.indexOf('WHERE ') + 'WHERE '.length);
};

describe('resolveSortKeys', () => {
  it('appends the primary key so the sort is total', () => {
    expect(resolveSortKeys<Row>(schema, [{ field: 'name', direction: 'asc' }])).toEqual([
      { field: 'name', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ]);
  });

  it('leaves the primary key where the caller put it', () => {
    const keys: OrderBy<Row>[] = [
      { field: 'id', direction: 'desc' },
      { field: 'name', direction: 'asc' },
    ];
    expect(resolveSortKeys<Row>(schema, keys)).toEqual(keys);
  });

  it('defaults to the primary key ascending', () => {
    expect(resolveSortKeys<Row>(schema, undefined)).toEqual([{ field: 'id', direction: 'asc' }]);
  });

  it('refuses to page by a json field, which has no total order', () => {
    expect(() => resolveSortKeys<Row>(schema, [{ field: 'meta', direction: 'asc' }])).toThrow(
      QueryError,
    );
  });

  it('refuses an unknown sort field', () => {
    expect(() =>
      resolveSortKeys<Row>(schema, [{ field: 'nope' as keyof Row & string, direction: 'asc' }]),
    ).toThrow(QueryError);
  });
});

describe('cursor tokens', () => {
  const keys: OrderBy<Row>[] = [
    { field: 'releasedAt', direction: 'desc' },
    { field: 'id', direction: 'asc' },
  ];
  const row: Row = {
    id: 'abc',
    name: 'x',
    quantity: 1,
    releasedAt: new Date('2024-01-02T03:04:05.678Z'),
    meta: null,
  };

  it('round trips values, rebuilding a Date as a Date', () => {
    const token = encodeCursor(schema, keys, row);
    const [releasedAt, id] = decodeCursor(schema, keys, token);
    expect(releasedAt).toBeInstanceOf(Date);
    expect((releasedAt as Date).toISOString()).toBe(row.releasedAt?.toISOString());
    expect(id).toBe('abc');
  });

  it('round trips a null sort value', () => {
    const token = encodeCursor(schema, keys, { ...row, releasedAt: null });
    expect(decodeCursor(schema, keys, token)).toEqual([null, 'abc']);
  });

  it('is opaque: url safe with no padding to mangle in a query string', () => {
    const token = encodeCursor(schema, keys, row);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses a token minted under a different sort order', () => {
    const token = encodeCursor(schema, keys, row);
    const other: OrderBy<Row>[] = [
      { field: 'releasedAt', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ];
    expect(() => decodeCursor(schema, other, token)).toThrow(/different sort order/);
  });

  it('refuses a token from a different layout version', () => {
    const forged = Buffer.from(JSON.stringify({ v: 99, s: 'x', k: [] }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeCursor(schema, keys, forged)).toThrow(/different version/);
  });

  it('refuses a token that is not a token at all', () => {
    expect(() => decodeCursor(schema, keys, 'nonsense!!')).toThrow(QueryError);
    const notAnObject = Buffer.from('"a string"', 'utf8').toString('base64url');
    expect(() => decodeCursor(schema, keys, notAnObject)).toThrow(QueryError);
  });

  it('refuses a token whose value does not match the declared field type', () => {
    const token = encodeCursor(schema, keys, row);
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as {
      k: unknown[];
    };
    decoded.k[1] = 42;
    const forged = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    expect(() => decodeCursor(schema, keys, forged)).toThrow(/non-string/);
  });
});

describe('keysetFilter', () => {
  it('compiles a single ascending key to a plain comparison', () => {
    expect(predicate([{ field: 'id', direction: 'asc' }], ['abc'])).toBe('(id > ? OR id IS NULL)');
  });

  it('compiles a single descending key to the mirrored comparison', () => {
    expect(predicate([{ field: 'id', direction: 'desc' }], ['abc'])).toBe('id < ?');
  });

  it('expands two keys lexicographically rather than as a row comparison', () => {
    // Row-value comparison, (a, b) > ($1, $2), would be tidier and would be wrong the
    // moment the two keys sort in different directions.
    const sql = predicate(
      [
        { field: 'quantity', direction: 'desc' },
        { field: 'id', direction: 'asc' },
      ],
      [5, 'abc'],
    );
    expect(sql).toBe('(quantity < ? OR (quantity = ? AND (id > ? OR id IS NULL)))');
  });

  it('treats an ascending null as the end of the order, since nulls sort last', () => {
    // Nothing sorts after a null under ASC NULLS LAST, so the only way forward is the
    // tiebreaker: rows that are also null on this key, and later on the next key.
    const sql = predicate(
      [
        { field: 'releasedAt', direction: 'asc' },
        { field: 'id', direction: 'asc' },
      ],
      [null, 'abc'],
    );
    expect(sql).toBe('(released_at IS NULL AND (id > ? OR id IS NULL))');
  });

  it('treats a descending null as the start of the order, since nulls sort first', () => {
    const sql = predicate(
      [
        { field: 'releasedAt', direction: 'desc' },
        { field: 'id', direction: 'asc' },
      ],
      [null, 'abc'],
    );
    expect(sql).toBe(
      '(released_at IS NOT NULL OR (released_at IS NULL AND (id > ? OR id IS NULL)))',
    );
  });

  it('includes null rows after a non-null ascending value', () => {
    // Under ASC NULLS LAST every null row sorts after every non-null one, so they belong
    // in the remainder. Leaving them out would silently drop them from the last pages.
    const sql = predicate(
      [
        { field: 'releasedAt', direction: 'asc' },
        { field: 'id', direction: 'asc' },
      ],
      [new Date('2024-01-01T00:00:00.000Z'), 'abc'],
    );
    expect(sql).toContain('(released_at > ? OR released_at IS NULL)');
  });

  it('binds every value it compares, in order', () => {
    const keys: OrderBy<Row>[] = [
      { field: 'quantity', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ];
    const { params } = compileSelect<Row>(
      schema,
      't',
      { where: [keysetFilter(keys, [7, 'abc'])] },
      'postgres',
    );
    expect(params).toEqual([7, 7, 'abc']);
  });
});
