import type { Dialect } from './dialect.js';
import { SchemaError } from './errors.js';
import type { FieldDef, FieldType, Schema } from './schema.js';
import type { IdStrategy } from './repo.js';

/**
 * `CREATE TABLE IF NOT EXISTS` generation from the schema descriptor.
 *
 * This is a dev and test convenience so a new project (and the conformance suite) can get
 * a table without hand-written SQL. It is deliberately NOT a migration engine: it never
 * alters or drops an existing table, and it will not notice drift. Once a schema is in
 * production, use a real migration tool (node-pg-migrate, or a SQL file runner for
 * SQLite) and treat `ensureTable()` as a local-development shortcut.
 */

function sqliteType(type: FieldType): string {
  switch (type) {
    case 'string':
      return 'TEXT';
    case 'number':
      return 'REAL';
    case 'integer':
      return 'INTEGER';
    case 'boolean':
      return 'INTEGER';
    case 'date':
      return 'TEXT';
    case 'json':
      return 'TEXT';
  }
}

function postgresType(type: FieldType): string {
  switch (type) {
    case 'string':
      return 'TEXT';
    case 'number':
      return 'DOUBLE PRECISION';
    case 'integer':
      return 'BIGINT';
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'TIMESTAMPTZ';
    case 'json':
      return 'JSONB';
  }
}

function literal(value: unknown, type: FieldType): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') {
    return type === 'boolean' ? String(value) : value ? '1' : '0';
  }
  if (value instanceof Date) return `'${value.toISOString()}'`;
  const text = type === 'json' ? JSON.stringify(value) : String(value);
  // Defaults come from the schema the developer wrote, not from user input, but escaping
  // is still the correct thing to do rather than trusting the source.
  return `'${text.replace(/'/g, "''")}'`;
}

function columnClause(
  name: string,
  def: FieldDef,
  schema: Schema,
  dialect: Dialect,
  ids: IdStrategy,
): string {
  const column = schema.columns[name] as string;
  const isPk = name === schema.primaryKey;
  const parts: string[] = [column];

  if (isPk && ids === 'autoincrement') {
    if (def.type !== 'integer') {
      throw new SchemaError(
        `Primary key "${name}" must be type "integer" to use the "autoincrement" id ` +
          `strategy, but it is "${def.type}".`,
      );
    }
    // The one place the DDL genuinely cannot be shared: these are different features
    // with the same purpose, not different spellings of one feature.
    parts.push(
      dialect === 'sqlite'
        ? 'INTEGER PRIMARY KEY AUTOINCREMENT'
        : 'BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY',
    );
    return parts.join(' ');
  }

  parts.push(dialect === 'sqlite' ? sqliteType(def.type) : postgresType(def.type));
  if (isPk) parts.push('PRIMARY KEY');
  if (!def.nullable && !isPk) parts.push('NOT NULL');
  if (def.unique && !isPk) parts.push('UNIQUE');
  if (def.default !== undefined) parts.push(`DEFAULT ${literal(def.default, def.type)}`);

  return parts.join(' ');
}

/**
 * Returns the statements that create the table, in execution order. Split into separate
 * statements because both drivers execute one statement per call on the paths we use.
 */
export function createTableStatements(
  schema: Schema,
  table: string,
  dialect: Dialect,
  ids: IdStrategy = 'uuid',
): string[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new SchemaError(
      `Table name ${JSON.stringify(table)} is not a plain identifier. Table names must ` +
        `match /^[A-Za-z_][A-Za-z0-9_]*$/ because repolayer never interpolates arbitrary ` +
        `text into SQL.`,
    );
  }

  const columns = schema.fieldNames.map((name) =>
    columnClause(name, schema.fields[name] as FieldDef, schema, dialect, ids),
  );

  return [`CREATE TABLE IF NOT EXISTS ${table} (\n  ${columns.join(',\n  ')}\n)`];
}

/** Drops the table. Used only by the conformance suite's cleanup. */
export function dropTableStatement(table: string): string {
  return `DROP TABLE IF EXISTS ${table}`;
}
