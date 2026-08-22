import type { Dialect } from './dialect.js';
import { SchemaError } from './errors.js';
import type { FieldDef, FieldMap, FieldType, Schema } from './schema.js';
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

/**
 * Column charset and collation for every string column repolayer creates on MySQL.
 *
 * Binary, not the server default. MySQL and MariaDB both default to a case-insensitive
 * collation, which would make `=`, `in`, `unique`, and `ORDER BY` on text behave
 * differently than they do on SQLite and Postgres. That is precisely the kind of quiet
 * divergence this package exists to prevent, so the columns are created case sensitive and
 * `ilike` asks for insensitivity explicitly when it wants it.
 */
const MYSQL_TEXT_COLLATION = 'CHARACTER SET utf8mb4 COLLATE utf8mb4_bin';

/** Length used for a string column that has to be indexable. */
const MYSQL_KEY_LENGTH = 255;

function mysqlType(type: FieldType, indexed: boolean): string {
  switch (type) {
    case 'string':
      // MySQL cannot index a TEXT column without a prefix length, and cannot give one a
      // literal DEFAULT at all, so anything indexed or defaulted becomes a VARCHAR.
      return indexed
        ? `VARCHAR(${MYSQL_KEY_LENGTH}) ${MYSQL_TEXT_COLLATION}`
        : `TEXT ${MYSQL_TEXT_COLLATION}`;
    case 'number':
      return 'DOUBLE';
    case 'integer':
      return 'BIGINT';
    case 'boolean':
      return 'TINYINT(1)';
    case 'date':
      // Microsecond precision, so a JS millisecond survives the round trip.
      return 'DATETIME(6)';
    case 'json':
      // LONGTEXT rather than MySQL's native JSON, so both flavors store the exact text
      // `toDb` produced. A native JSON column holds a normalized document, and comparing
      // one against a bound string does not match on MySQL even when the document is the
      // same, which would make `eq` and `ne` on a json field answer differently there than
      // on MariaDB, SQLite, and MemoryRepo. MariaDB's JSON is a LONGTEXT alias already, so
      // this is what that flavor was doing all along.
      return 'LONGTEXT';
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

/**
 * Renders a schema default as a SQL literal.
 *
 * Dialect aware on purpose: a boolean default has to be written the way the column stores
 * it, or a row that takes the default would hold a different value than a row the adapter
 * inserted. SQLite keeps booleans as INTEGER 0/1 (see `toDb`), Postgres as BOOLEAN.
 */
function columnType(type: FieldType, dialect: Dialect, indexed: boolean): string {
  if (dialect === 'sqlite') return sqliteType(type);
  if (dialect === 'mysql') return mysqlType(type, indexed);
  return postgresType(type);
}

function literal(value: unknown, type: FieldType, dialect: Dialect): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') {
    if (type !== 'boolean') return value ? '1' : '0';
    return dialect === 'sqlite' ? (value ? '1' : '0') : String(value);
  }
  if (value instanceof Date) return `'${value.toISOString()}'`;
  let text: string;
  if (type === 'json') {
    text = JSON.stringify(value);
  } else if (typeof value === 'string') {
    text = value;
  } else {
    // Stringifying an object here would emit `DEFAULT '[object Object]'`, which is a
    // silently wrong table rather than an error. Say so instead.
    throw new SchemaError(
      `Default value for a ${type} column must be a string, number, boolean, or Date, ` +
        `not ${typeof value}. Use a json column if the default is structured.`,
    );
  }
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
    // The one place the DDL genuinely cannot be shared: these are three different
    // features with the same purpose, not three spellings of one feature.
    if (dialect === 'sqlite') parts.push('INTEGER PRIMARY KEY AUTOINCREMENT');
    else if (dialect === 'mysql') parts.push('BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY');
    else parts.push('BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY');
    return parts.join(' ');
  }

  // A column carries an index, or a default, only if it is a key, is unique, or declares
  // one. On MySQL that decides between VARCHAR and TEXT.
  const indexed = isPk || def.unique === true || def.default !== undefined;
  parts.push(columnType(def.type, dialect, indexed));
  if (isPk) parts.push('PRIMARY KEY');
  if (!def.nullable && !isPk) parts.push('NOT NULL');
  if (def.unique && !isPk) parts.push('UNIQUE');
  if (def.default !== undefined) {
    parts.push(`DEFAULT ${literal(def.default, def.type, dialect)}`);
  }

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

  const fields = schema.fields as FieldMap;
  const columns = schema.fieldNames.map((name) =>
    columnClause(name, fields[name] as FieldDef, schema, dialect, ids),
  );

  return [`CREATE TABLE IF NOT EXISTS ${table} (\n  ${columns.join(',\n  ')}\n)`];
}

/** Drops the table. Used only by the conformance suite's cleanup. */
export function dropTableStatement(table: string): string {
  return `DROP TABLE IF EXISTS ${table}`;
}
