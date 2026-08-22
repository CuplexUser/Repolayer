import { describe, expect, it } from 'vitest';

import { defineSchema } from '../../src/core/schema.js';
import { QueryError, SchemaError } from '../../src/core/errors.js';
import {
  compileCount,
  compileSelect,
  type FieldFilter,
  type Filter,
  type QueryOptions,
} from '../../src/core/query.js';
import { createTableStatements } from '../../src/core/ddl.js';
import type { Dialect } from '../../src/core/dialect.js';

/**
 * Compiler-level tests. These need no database, so they run everywhere and cover the
 * Postgres SQL that the conformance suite can only reach with a live server.
 */

const schema = defineSchema({
  id: { type: 'string', primaryKey: true },
  name: { type: 'string' },
  quantity: { type: 'integer' },
  active: { type: 'boolean' },
  meta: { type: 'json', nullable: true },
  releasedAt: { type: 'date', nullable: true, column: 'released_at' },
});

interface Row {
  id: string;
  name: string;
  quantity: number;
  active: boolean;
  meta: unknown | null;
  releasedAt: Date | null;
}

const select = (query: QueryOptions<Row> | undefined, dialect: Dialect) =>
  compileSelect<Row>(schema, 'widgets', query, dialect);

describe('compileSelect', () => {
  it('projects the schema columns explicitly rather than SELECT *', () => {
    const { sql } = select(undefined, 'sqlite');
    expect(sql).toBe('SELECT id, name, quantity, active, meta, released_at FROM widgets');
  });

  it('uses ? placeholders on sqlite and $n on postgres', () => {
    const query: QueryOptions<Row> = {
      where: [
        { field: 'name', op: 'eq', value: 'a' },
        { field: 'quantity', op: 'gt', value: 2 },
      ],
    };
    expect(select(query, 'sqlite').sql).toContain('WHERE name = ? AND quantity > ?');
    expect(select(query, 'postgres').sql).toContain('WHERE name = $1 AND quantity > $2');
  });

  it('binds the same parameter values on both dialects, in the same order', () => {
    const query: QueryOptions<Row> = {
      where: [
        { field: 'name', op: 'in', value: ['a', 'b'] },
        { field: 'quantity', op: 'lte', value: 9 },
      ],
      limit: 5,
      offset: 10,
    };
    expect(select(query, 'sqlite').params).toEqual(['a', 'b', 9, 5, 10]);
    expect(select(query, 'postgres').params).toEqual(['a', 'b', 9, 5, 10]);
  });

  it('always states the null ordering position, so the engines cannot disagree', () => {
    const query: QueryOptions<Row> = {
      orderBy: [
        { field: 'releasedAt', direction: 'asc' },
        { field: 'name', direction: 'desc' },
      ],
    };
    const expected = ' ORDER BY released_at ASC NULLS LAST, name DESC NULLS FIRST';
    expect(select(query, 'sqlite').sql).toContain(expected);
    expect(select(query, 'postgres').sql).toContain(expected);
  });

  it('spells an unbounded limit the way each engine accepts', () => {
    // Postgres rejects a negative LIMIT, and SQLite has no LIMIT ALL, so this one clause
    // genuinely has to differ.
    expect(select({ offset: 5 }, 'sqlite').sql).toContain(' LIMIT -1 OFFSET ?');
    expect(select({ offset: 5 }, 'postgres').sql).toContain(' LIMIT ALL OFFSET $1');
  });

  it('maps like and ilike onto each engine so both mean the same thing', () => {
    const like: QueryOptions<Row> = { where: [{ field: 'name', op: 'like', value: 'A%' }] };
    expect(select(like, 'sqlite').sql).toContain('name LIKE ?');
    expect(select(like, 'postgres').sql).toContain('name LIKE $1');

    const ilike: QueryOptions<Row> = { where: [{ field: 'name', op: 'ilike', value: 'a%' }] };
    // SQLite has no ILIKE, so case insensitivity is produced explicitly.
    expect(select(ilike, 'sqlite').sql).toContain('LOWER(name) LIKE LOWER(?)');
    expect(select(ilike, 'postgres').sql).toContain('name ILIKE $1');
  });

  it('collapses an empty in and nin to constants instead of invalid SQL', () => {
    for (const dialect of ['sqlite', 'postgres'] as const) {
      expect(select({ where: [{ field: 'name', op: 'in', value: [] }] }, dialect).sql).toContain(
        'WHERE 1 = 0',
      );
      expect(select({ where: [{ field: 'name', op: 'nin', value: [] }] }, dialect).sql).toContain(
        'WHERE 1 = 1',
      );
    }
  });

  it('keeps nulls in ne and nin results on both dialects', () => {
    const ne = select({ where: [{ field: 'name', op: 'ne', value: 'a' }] }, 'postgres');
    expect(ne.sql).toContain('(name <> $1 OR name IS NULL)');

    const nin = select({ where: [{ field: 'name', op: 'nin', value: ['a'] }] }, 'sqlite');
    expect(nin.sql).toContain('(name NOT IN (?) OR name IS NULL)');
  });

  it('turns eq null into IS NULL rather than a comparison that never matches', () => {
    const { sql, params } = select({ where: [{ field: 'meta', op: 'eq', value: null }] }, 'sqlite');
    expect(sql).toContain('meta IS NULL');
    expect(params).toEqual([]);
  });

  it('reads the object form of where as an implicit AND of equality', () => {
    const { sql, params } = select({ where: { name: 'a', active: true } }, 'postgres');
    expect(sql).toContain('WHERE name = $1 AND active = $2');
    expect(params).toEqual(['a', true]);
  });

  it('serializes values per dialect when binding them', () => {
    const released = new Date('2024-01-02T03:04:05.678Z');
    const query: QueryOptions<Row> = {
      where: [
        { field: 'active', op: 'eq', value: true },
        { field: 'releasedAt', op: 'gt', value: released },
      ],
    };
    // SQLite has no boolean or date type, so the same query binds different values.
    expect(select(query, 'sqlite').params).toEqual([1, '2024-01-02T03:04:05.678Z']);
    expect(select(query, 'postgres').params).toEqual([true, released]);
  });

  it('rejects unknown fields, operators, and directions before building SQL', () => {
    const bad = { field: 'nope', op: 'eq', value: 1 } as unknown as FieldFilter<Row>;
    expect(() => select({ where: [bad] }, 'sqlite')).toThrow(QueryError);

    const badOp = { field: 'name', op: 'regex', value: 'x' } as unknown as FieldFilter<Row>;
    expect(() => select({ where: [badOp] }, 'sqlite')).toThrow(QueryError);

    expect(() =>
      select({ orderBy: [{ field: 'name', direction: 'sideways' as 'asc' }] }, 'sqlite'),
    ).toThrow(QueryError);

    expect(() => select({ limit: 1.5 }, 'sqlite')).toThrow(QueryError);
    expect(() => select({ offset: -1 }, 'sqlite')).toThrow(QueryError);
  });

  it('requires an array for in and nin, and a string for like', () => {
    expect(() => select({ where: [{ field: 'name', op: 'in', value: 'a' }] }, 'sqlite')).toThrow(
      QueryError,
    );
    expect(() => select({ where: [{ field: 'name', op: 'like', value: 5 }] }, 'sqlite')).toThrow(
      QueryError,
    );
  });
});

describe('compileCount', () => {
  it('honors filters and ignores ordering', () => {
    const { sql, params } = compileCount<Row>(
      schema,
      'widgets',
      { where: [{ field: 'active', op: 'eq', value: true }], orderBy: [] },
      'postgres',
    );
    expect(sql).toBe('SELECT COUNT(*) AS count FROM widgets WHERE active = $1');
    expect(params).toEqual([true]);
  });
});

describe('createTableStatements', () => {
  it('maps every field type onto the sqlite storage class', () => {
    const [sql] = createTableStatements(schema, 'widgets', 'sqlite');
    expect(sql).toContain('id TEXT PRIMARY KEY');
    expect(sql).toContain('quantity INTEGER NOT NULL');
    expect(sql).toContain('active INTEGER NOT NULL');
    expect(sql).toContain('meta TEXT');
    expect(sql).toContain('released_at TEXT');
    expect(sql).not.toContain('released_at TEXT NOT NULL');
  });

  it('maps every field type onto the postgres column type', () => {
    const [sql] = createTableStatements(schema, 'widgets', 'postgres');
    expect(sql).toContain('id TEXT PRIMARY KEY');
    expect(sql).toContain('quantity BIGINT NOT NULL');
    expect(sql).toContain('active BOOLEAN NOT NULL');
    expect(sql).toContain('meta JSONB');
    expect(sql).toContain('released_at TIMESTAMPTZ');
  });

  it('uses each engine own auto-increment feature', () => {
    const numeric = defineSchema({
      id: { type: 'integer', primaryKey: true },
      name: { type: 'string' },
    });
    expect(createTableStatements(numeric, 't', 'sqlite', 'autoincrement')[0]).toContain(
      'id INTEGER PRIMARY KEY AUTOINCREMENT',
    );
    expect(createTableStatements(numeric, 't', 'postgres', 'autoincrement')[0]).toContain(
      'id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY',
    );
  });

  it('refuses autoincrement on a non-integer primary key', () => {
    expect(() => createTableStatements(schema, 't', 'sqlite', 'autoincrement')).toThrow(
      SchemaError,
    );
  });

  it('emits UNIQUE for unique fields and IF NOT EXISTS for the table', () => {
    const withUnique = defineSchema({
      id: { type: 'string', primaryKey: true },
      slug: { type: 'string', unique: true },
    });
    const [sql] = createTableStatements(withUnique, 'things', 'postgres');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS things');
    expect(sql).toContain('slug TEXT NOT NULL UNIQUE');
  });

  it('refuses a table name that is not a plain identifier', () => {
    expect(() => createTableStatements(schema, 'widgets; DROP TABLE users', 'sqlite')).toThrow(
      SchemaError,
    );
  });
});

describe('createTableStatements defaults', () => {
  it('emits a quoted default for a string and escapes an embedded quote', () => {
    const withDefaults = defineSchema({
      id: { type: 'string', primaryKey: true },
      label: { type: 'string', default: "it's fine" },
    });
    const [sql] = createTableStatements(withDefaults, 't', 'sqlite');
    expect(sql).toContain("label TEXT NOT NULL DEFAULT 'it''s fine'");
  });

  it('emits numeric and boolean defaults per dialect', () => {
    const withDefaults = defineSchema({
      id: { type: 'string', primaryKey: true },
      quantity: { type: 'integer', default: 0 },
      active: { type: 'boolean', default: true },
    });

    const [sqlite] = createTableStatements(withDefaults, 't', 'sqlite');
    // SQLite has no boolean type, so the default has to be written the way the column
    // stores it, or the stored default would not round trip as a boolean.
    expect(sqlite).toContain('quantity INTEGER NOT NULL DEFAULT 0');
    expect(sqlite).toContain('active INTEGER NOT NULL DEFAULT 1');

    const [postgres] = createTableStatements(withDefaults, 't', 'postgres');
    expect(postgres).toContain('active BOOLEAN NOT NULL DEFAULT true');
  });

  it('emits an ISO literal for a Date default and JSON for a json default', () => {
    const withDefaults = defineSchema({
      id: { type: 'string', primaryKey: true },
      at: { type: 'date', default: new Date('2024-02-03T04:05:06.007Z') },
      meta: { type: 'json', default: { a: [1, 2] } },
    });
    const [sql] = createTableStatements(withDefaults, 't', 'postgres');
    expect(sql).toContain("DEFAULT '2024-02-03T04:05:06.007Z'");
    expect(sql).toContain('DEFAULT \'{"a":[1,2]}\'');
  });

  it('emits NULL for an explicitly null default', () => {
    const withDefaults = defineSchema({
      id: { type: 'string', primaryKey: true },
      note: { type: 'string', nullable: true, default: null },
    });
    const [sql] = createTableStatements(withDefaults, 't', 'sqlite');
    expect(sql).toContain('note TEXT DEFAULT NULL');
  });

  it('refuses an object default on a non-json column instead of stringifying it', () => {
    // String(value) here would emit DEFAULT '[object Object]', which is a silently wrong
    // table rather than an error.
    const bad = defineSchema({
      id: { type: 'string', primaryKey: true },
      label: { type: 'string', default: { oops: true } },
    });
    expect(() => createTableStatements(bad, 't', 'sqlite')).toThrow(SchemaError);
  });
});

describe('filter trees', () => {
  it('compiles an or group with parentheses so precedence cannot slip', () => {
    const { sql, params } = select(
      {
        where: [
          { field: 'active', op: 'eq', value: true },
          {
            or: [
              { field: 'quantity', op: 'gt', value: 10 },
              { field: 'name', op: 'eq', value: 'Anvil' },
            ],
          },
        ],
      },
      'postgres',
    );
    expect(sql).toContain('WHERE active = $1 AND (quantity > $2 OR name = $3)');
    expect(params).toEqual([true, 10, 'Anvil']);
  });

  it('compiles nested and inside or', () => {
    const { sql } = select(
      {
        where: [
          {
            or: [
              {
                and: [
                  { field: 'active', op: 'eq', value: true },
                  { field: 'quantity', op: 'lt', value: 5 },
                ],
              },
              { field: 'name', op: 'eq', value: 'x' },
            ],
          },
        ],
      },
      'sqlite',
    );
    expect(sql).toContain('WHERE ((active = ? AND quantity < ?) OR name = ?)');
  });

  it('does not parenthesize a group of one, which needs no grouping', () => {
    const { sql } = select(
      { where: [{ or: [{ field: 'name', op: 'eq', value: 'x' }] }] },
      'sqlite',
    );
    expect(sql).toContain('WHERE name = ?');
  });

  it('collapses an empty group to a constant rather than invalid SQL', () => {
    expect(select({ where: [{ or: [] }] }, 'sqlite').sql).toContain('WHERE 1 = 0');
    expect(select({ where: [{ and: [] }] }, 'sqlite').sql).toContain('WHERE 1 = 1');
  });

  it('binds parameters in the order they are written, on both dialects', () => {
    const query: QueryOptions<Row> = {
      where: [
        {
          or: [
            { field: 'quantity', op: 'in', value: [1, 2] },
            {
              and: [
                { field: 'name', op: 'like', value: 'a%' },
                { field: 'active', op: 'eq', value: false },
              ],
            },
          ],
        },
      ],
    };
    expect(select(query, 'sqlite').params).toEqual([1, 2, 'a%', 0]);
    expect(select(query, 'postgres').params).toEqual([1, 2, 'a%', false]);
  });

  it('refuses a tree nested past the depth limit', () => {
    let node: Filter<Row> = { field: 'name', op: 'eq', value: 'x' };
    for (let i = 0; i < 20; i += 1) node = { and: [node] };
    expect(() => select({ where: [node] }, 'sqlite')).toThrow(QueryError);
  });

  it('still rejects an unknown field inside a group', () => {
    const bad = { field: 'nope', op: 'eq', value: 1 } as unknown as FieldFilter<Row>;
    expect(() => select({ where: [{ or: [bad] }] }, 'sqlite')).toThrow(QueryError);
  });

  it('rejects a filter node that is neither a group nor a field comparison', () => {
    const bad = { field: 'name' } as unknown as FieldFilter<Row>;
    expect(() => select({ where: [bad] }, 'sqlite')).toThrow(QueryError);
  });
});
