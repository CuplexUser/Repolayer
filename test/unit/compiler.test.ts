import { describe, expect, it } from 'vitest';

import { defineSchema } from '../../src/core/schema.js';
import { QueryError, SchemaError } from '../../src/core/errors.js';
import {
  compileCount,
  compileSelect,
  type FieldFilter,
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
    expect(() =>
      select({ where: [{ field: 'name', op: 'in', value: 'a' }] }, 'sqlite'),
    ).toThrow(QueryError);
    expect(() =>
      select({ where: [{ field: 'name', op: 'like', value: 5 }] }, 'sqlite'),
    ).toThrow(QueryError);
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
