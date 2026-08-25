import { describe, expect, it } from 'vitest';

import { diffTable, type LiveColumn, type TableShape } from '../../src/core/introspect.js';
import type { Dialect } from '../../src/core/dialect.js';
import { defineSchema } from '../../src/core/schema.js';

/**
 * `diffTable` is pure, so the whole matrix of types, dialects, and findings is exercised
 * here against hand-built shapes with no database anywhere. What the conformance suite adds
 * on top is only that each adapter reads its own catalog correctly.
 */

const schema = defineSchema({
  id: { type: 'string', primaryKey: true },
  slug: { type: 'string', unique: true },
  quantity: { type: 'integer' },
  weight: { type: 'number' },
  active: { type: 'boolean' },
  meta: { type: 'json', nullable: true },
  createdAt: { type: 'date', column: 'created_at' },
});

/** The column list a correct table has, per dialect. */
const CORRECT: Record<Exclude<Dialect, 'memory'>, Record<string, string>> = {
  sqlite: {
    id: 'TEXT',
    slug: 'TEXT',
    quantity: 'INTEGER',
    weight: 'REAL',
    active: 'INTEGER',
    meta: 'TEXT',
    created_at: 'TEXT',
  },
  postgres: {
    id: 'text',
    slug: 'text',
    quantity: 'bigint',
    weight: 'double precision',
    active: 'boolean',
    meta: 'jsonb',
    created_at: 'timestamp with time zone',
  },
  mysql: {
    id: 'varchar',
    slug: 'varchar',
    quantity: 'bigint',
    weight: 'double',
    active: 'tinyint',
    meta: 'longtext',
    created_at: 'datetime',
  },
};

const NULLABLE = new Set(['meta']);

function shapeFor(dialect: Exclude<Dialect, 'memory'>, overrides: Partial<LiveColumn>[] = []) {
  const columns: LiveColumn[] = Object.entries(CORRECT[dialect]).map(([column, dataType]) => ({
    column,
    dataType,
    nullable: NULLABLE.has(column),
    primaryKey: column === 'id',
    hasDefault: false,
    ...(dialect === 'mysql' && (column === 'id' || column === 'slug')
      ? { collation: 'utf8mb4_bin' }
      : {}),
  }));

  for (const override of overrides) {
    const index = columns.findIndex((c) => c.column === override.column);
    if (index >= 0) columns[index] = { ...(columns[index] as LiveColumn), ...override };
  }

  const shape: TableShape = { exists: true, columns, uniqueColumns: ['slug'] };
  return shape;
}

const dialects: Exclude<Dialect, 'memory'>[] = ['sqlite', 'postgres', 'mysql'];

describe('diffTable', () => {
  for (const dialect of dialects) {
    it(`reports no drift on a table matching the schema (${dialect})`, () => {
      const diff = diffTable(schema, 'widgets', shapeFor(dialect), dialect);
      expect(diff.findings).toEqual([]);
      expect(diff.ok).toBe(true);
      expect(diff.table).toBe('widgets');
    });
  }

  it('reports a missing table and nothing else', () => {
    const diff = diffTable(
      schema,
      'widgets',
      { exists: false, columns: [], uniqueColumns: [] },
      'sqlite',
    );
    expect(diff.ok).toBe(false);
    expect(diff.findings).toHaveLength(1);
    expect(diff.findings[0]?.kind).toBe('missingTable');
  });

  it('reports a column the schema names and the table does not have', () => {
    const shape = shapeFor('postgres');
    shape.columns = shape.columns.filter((c) => c.column !== 'created_at');
    const diff = diffTable(schema, 'widgets', shape, 'postgres');
    expect(diff.ok).toBe(false);
    const finding = diff.findings.find((f) => f.kind === 'missingColumn');
    expect(finding?.field).toBe('createdAt');
    expect(finding?.column).toBe('created_at');
  });

  it('matches column names case insensitively, because Postgres folds them', () => {
    const shape = shapeFor('postgres');
    // A schema field `createdAt` is a `createdat` column once Postgres has folded it.
    shape.columns = shape.columns.map((c) =>
      c.column === 'created_at' ? { ...c, column: 'CREATED_AT' } : c,
    );
    expect(diffTable(schema, 'widgets', shape, 'postgres').findings).toEqual([]);
  });

  describe('types', () => {
    it('rejects a zoneless timestamp for a date field on postgres', () => {
      const shape = shapeFor('postgres', [
        { column: 'created_at', dataType: 'timestamp without time zone' },
      ]);
      const diff = diffTable(schema, 'widgets', shape, 'postgres');
      expect(diff.ok).toBe(false);
      const finding = diff.findings.find((f) => f.kind === 'typeIncompatible');
      expect(finding?.field).toBe('createdAt');
      expect(finding?.expected).toBe('timestamp with time zone');
    });

    it('rejects a text column for a json field on postgres, which nobody would parse', () => {
      const shape = shapeFor('postgres', [{ column: 'meta', dataType: 'text' }]);
      const diff = diffTable(schema, 'widgets', shape, 'postgres');
      expect(diff.findings.find((f) => f.kind === 'typeIncompatible')?.field).toBe('meta');
      expect(diff.ok).toBe(false);
    });

    it('rejects native json for a json field on mysql, which stops eq from matching', () => {
      const shape = shapeFor('mysql', [{ column: 'meta', dataType: 'json' }]);
      const diff = diffTable(schema, 'widgets', shape, 'mysql');
      expect(diff.findings.find((f) => f.kind === 'typeIncompatible')?.field).toBe('meta');
    });

    it('rejects TIMESTAMP for a date field on mysql', () => {
      const shape = shapeFor('mysql', [{ column: 'created_at', dataType: 'timestamp' }]);
      expect(diffTable(schema, 'widgets', shape, 'mysql').ok).toBe(false);
    });

    it('rejects DECIMAL for a number field on mysql, which mysql2 returns as a string', () => {
      const shape = shapeFor('mysql', [{ column: 'weight', dataType: 'decimal' }]);
      expect(diffTable(schema, 'widgets', shape, 'mysql').ok).toBe(false);
    });

    it('accepts any declared type with the right SQLite affinity', () => {
      // VARCHAR(80), CLOB, and TEXT are the same column as far as SQLite is concerned.
      const shape = shapeFor('sqlite', [
        { column: 'id', dataType: 'VARCHAR(80)' },
        { column: 'slug', dataType: 'CLOB' },
        { column: 'quantity', dataType: 'BIGINT' },
        // DECIMAL falls through every affinity rule to NUMERIC, which a number accepts.
        { column: 'weight', dataType: 'DECIMAL(10,2)' },
      ]);
      expect(diffTable(schema, 'widgets', shape, 'sqlite').findings).toEqual([]);
    });

    it('rejects a blob affinity, which an undeclared SQLite column falls back to', () => {
      const shape = shapeFor('sqlite', [{ column: 'slug', dataType: '' }]);
      const diff = diffTable(schema, 'widgets', shape, 'sqlite');
      expect(diff.findings.find((f) => f.kind === 'typeIncompatible')?.field).toBe('slug');
    });

    it('rejects an integer affinity for a date field on sqlite', () => {
      const shape = shapeFor('sqlite', [{ column: 'created_at', dataType: 'INTEGER' }]);
      const diff = diffTable(schema, 'widgets', shape, 'sqlite');
      expect(diff.findings.find((f) => f.kind === 'typeIncompatible')?.field).toBe('createdAt');
    });

    it('warns rather than fails on a type it has no opinion on', () => {
      const shape = shapeFor('postgres', [{ column: 'slug', dataType: 'citext' }]);
      const diff = diffTable(schema, 'widgets', shape, 'postgres');
      const finding = diff.findings.find((f) => f.kind === 'typeUnknown');
      expect(finding?.severity).toBe('warning');
      // A warning does not clear ok: repolayer is reporting, not refusing.
      expect(diff.ok).toBe(true);
    });
  });

  describe('constraints', () => {
    it('reports a nullable column behind a field that is not nullable', () => {
      const shape = shapeFor('postgres', [{ column: 'slug', nullable: true }]);
      const diff = diffTable(schema, 'widgets', shape, 'postgres');
      const finding = diff.findings.find((f) => f.kind === 'nullabilityMismatch');
      expect(finding?.expected).toBe('not null');
      expect(finding?.actual).toBe('nullable');
      expect(diff.ok).toBe(false);
    });

    it('reports a NOT NULL column behind a nullable field', () => {
      const shape = shapeFor('postgres', [{ column: 'meta', nullable: false }]);
      const diff = diffTable(schema, 'widgets', shape, 'postgres');
      expect(diff.findings.find((f) => f.kind === 'nullabilityMismatch')?.field).toBe('meta');
    });

    it('does not compare nullability on the primary key', () => {
      // SQLite lets a `TEXT PRIMARY KEY` column hold NULL and reports it as nullable, so
      // comparing here would flag every SQLite table repolayer generated itself.
      const shape = shapeFor('sqlite', [{ column: 'id', nullable: true }]);
      expect(diffTable(schema, 'widgets', shape, 'sqlite').findings).toEqual([]);
    });

    it('reports a primary key on the wrong column', () => {
      const shape = shapeFor('postgres', [
        { column: 'id', primaryKey: false },
        { column: 'slug', primaryKey: true },
      ]);
      const diff = diffTable(schema, 'widgets', shape, 'postgres');
      const kinds = diff.findings.filter((f) => f.kind === 'primaryKeyMismatch');
      expect(kinds).toHaveLength(2);
      expect(diff.ok).toBe(false);
    });

    it('reports a unique the schema declares and the table does not carry', () => {
      const shape = shapeFor('postgres');
      shape.uniqueColumns = [];
      const diff = diffTable(schema, 'widgets', shape, 'postgres');
      expect(diff.findings.find((f) => f.kind === 'missingUnique')?.field).toBe('slug');
      expect(diff.ok).toBe(false);
    });

    it('warns about a unique the table carries and the schema does not declare', () => {
      const shape = shapeFor('postgres');
      shape.uniqueColumns = ['slug', 'quantity'];
      const diff = diffTable(schema, 'widgets', shape, 'postgres');
      const finding = diff.findings.find((f) => f.kind === 'extraUnique');
      expect(finding?.field).toBe('quantity');
      expect(finding?.severity).toBe('warning');
      expect(diff.ok).toBe(true);
    });

    it('does not mistake the primary key for an undeclared unique', () => {
      const shape = shapeFor('postgres');
      shape.uniqueColumns = ['slug', 'id'];
      expect(diffTable(schema, 'widgets', shape, 'postgres').findings).toEqual([]);
    });
  });

  describe('mysql collation', () => {
    it('reports a case insensitive collation on a string column', () => {
      const shape = shapeFor('mysql', [{ column: 'slug', collation: 'utf8mb4_0900_ai_ci' }]);
      const diff = diffTable(schema, 'widgets', shape, 'mysql');
      const finding = diff.findings.find((f) => f.kind === 'collationMismatch');
      expect(finding?.field).toBe('slug');
      expect(finding?.expected).toBe('utf8mb4_bin');
      expect(diff.ok).toBe(false);
    });

    it('does not check collation on the other engines', () => {
      const shape = shapeFor('postgres', [{ column: 'slug', collation: 'en_US.utf8' }]);
      expect(diffTable(schema, 'widgets', shape, 'postgres').findings).toEqual([]);
    });

    it('does not check collation on a non-string field', () => {
      const shape = shapeFor('mysql', [{ column: 'meta', collation: 'utf8mb4_0900_ai_ci' }]);
      expect(diffTable(schema, 'widgets', shape, 'mysql').findings).toEqual([]);
    });
  });

  describe('extra columns', () => {
    it('ignores one that is nullable, because reads name their columns', () => {
      const shape = shapeFor('postgres');
      shape.columns.push({
        column: 'legacy',
        dataType: 'text',
        nullable: true,
        primaryKey: false,
        hasDefault: false,
      });
      expect(diffTable(schema, 'widgets', shape, 'postgres').findings).toEqual([]);
    });

    it('ignores one that is NOT NULL but has a default', () => {
      const shape = shapeFor('postgres');
      shape.columns.push({
        column: 'legacy',
        dataType: 'text',
        nullable: false,
        primaryKey: false,
        hasDefault: true,
      });
      expect(diffTable(schema, 'widgets', shape, 'postgres').findings).toEqual([]);
    });

    it('reports one that is NOT NULL with no default, which breaks every insert', () => {
      const shape = shapeFor('postgres');
      shape.columns.push({
        column: 'legacy',
        dataType: 'text',
        nullable: false,
        primaryKey: false,
        hasDefault: false,
      });
      const diff = diffTable(schema, 'widgets', shape, 'postgres');
      const finding = diff.findings.find((f) => f.kind === 'extraRequiredColumn');
      expect(finding?.column).toBe('legacy');
      expect(diff.ok).toBe(false);
    });
  });

  it('collects every finding rather than stopping at the first', () => {
    const shape = shapeFor('mysql', [
      { column: 'created_at', dataType: 'timestamp' },
      { column: 'slug', collation: 'utf8mb4_0900_ai_ci', nullable: true },
    ]);
    shape.uniqueColumns = [];
    const diff = diffTable(schema, 'widgets', shape, 'mysql');
    expect(diff.findings.map((f) => f.kind).sort()).toEqual([
      'collationMismatch',
      'missingUnique',
      'nullabilityMismatch',
      'typeIncompatible',
    ]);
    expect(diff.ok).toBe(false);
  });
});
