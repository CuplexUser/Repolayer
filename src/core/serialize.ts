import type { Dialect } from './dialect.js';
import { QueryError } from './errors.js';
import type { FieldType, Schema } from './schema.js';

/**
 * The single place where the two engines are allowed to store the same value differently.
 *
 *   type      SQLite                            Postgres           MySQL / MariaDB
 *   -------   -------------------------------   ----------------   ----------------------
 *   string    TEXT                              TEXT               VARCHAR / TEXT
 *   number    REAL                              DOUBLE PRECISION   DOUBLE
 *   integer   INTEGER                           BIGINT             BIGINT
 *   boolean   INTEGER 0/1                       BOOLEAN            TINYINT(1) 0/1
 *   date      TEXT, ISO-8601 UTC, fixed width   TIMESTAMPTZ        DATETIME(6), UTC
 *   json      TEXT via JSON.stringify           JSONB              LONGTEXT
 *
 * Application code never sees the difference: `toDb`/`fromDb` round trip real `Date`
 * objects, real booleans, and real numbers on both engines.
 */

function fail(field: string, type: FieldType, value: unknown): never {
  throw new QueryError(`Field "${field}" is declared ${type} but received ${describe(value)}`);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Date) return 'a Date';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/** Converts one application value into the representation its column expects. */
export function toDb(value: unknown, type: FieldType, dialect: Dialect, field: string): unknown {
  if (value === null || value === undefined) return null;

  switch (type) {
    case 'string':
      if (typeof value !== 'string') fail(field, type, value);
      return value;

    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(field, type, value);
      return value;

    case 'integer':
      if (typeof value === 'bigint') {
        // Postgres and MySQL both take a BIGINT as text without losing digits; node:sqlite
        // takes a real bigint.
        return dialect === 'sqlite' || dialect === 'memory' ? value : value.toString();
      }
      if (typeof value !== 'number' || !Number.isInteger(value)) fail(field, type, value);
      return value;

    case 'boolean':
      if (typeof value !== 'boolean') fail(field, type, value);
      // Neither SQLite nor MySQL has a real boolean type: 0/1 keeps comparisons and
      // ORDER BY sane on both.
      if (dialect === 'sqlite' || dialect === 'mysql') return value ? 1 : 0;
      return value;

    case 'date': {
      if (!(value instanceof Date) || Number.isNaN(value.getTime())) fail(field, type, value);
      // Fixed-width ISO-8601 in UTC, so lexicographic TEXT ordering in SQLite matches
      // chronological ordering in Postgres.
      if (dialect === 'sqlite') return value.toISOString();
      // DATETIME carries no zone, so the value is written in UTC and read back as UTC.
      // Leaving the conversion to the driver's timezone setting is how applications end up
      // with timestamps that shift when the server moves.
      if (dialect === 'mysql') return toMysqlDateTime(value);
      return value;
    }

    case 'json':
      // Always stringify ourselves. Letting the driver infer would send a bare string
      // value as text, which Postgres then refuses to cast to jsonb.
      return JSON.stringify(value ?? null);
  }
}

/** Converts one database value back into its application representation. */
export function fromDb(value: unknown, type: FieldType, dialect: Dialect, field: string): unknown {
  if (value === null || value === undefined) return null;

  switch (type) {
    case 'string':
      return typeof value === 'string' ? value : toText(value, field);

    case 'number':
      return typeof value === 'number' ? value : Number(value);

    case 'integer':
      // Postgres returns BIGINT as a string, and node:sqlite can return a bigint.
      // Both are widened to number, but never silently past the point where that lies.
      return toSafeInteger(value, field);

    case 'boolean':
      return typeof value === 'boolean' ? value : value === 1 || value === '1' || value === 't';

    case 'date':
      if (value instanceof Date) return value;
      // A MySQL DATETIME arrives as "2024-03-05 06:07:08.123000" with no zone. Handing
      // that to `new Date()` would read it as local time and silently shift it.
      if (dialect === 'mysql' && typeof value === 'string') return fromMysqlDateTime(value);
      return new Date(value as string | number);

    case 'json':
      // Postgres drivers already parse jsonb into a JS value; SQLite hands back TEXT.
      // Parsing the Postgres result again would corrupt a legitimately stored string.
      if (dialect === 'postgres') return value;
      return typeof value === 'string' ? JSON.parse(value) : value;
  }
}

/** "2024-03-05T06:07:08.123Z" becomes "2024-03-05 06:07:08.123", which is what DATETIME wants. */
function toMysqlDateTime(value: Date): string {
  return value.toISOString().replace('T', ' ').replace('Z', '');
}

/** Reads a zoneless DATETIME string back as the UTC instant it was written as. */
function fromMysqlDateTime(value: string): Date {
  return new Date(`${value.replace(' ', 'T')}Z`);
}

/**
 * Coerces whatever a driver hands back for a TEXT column into a string.
 *
 * Drivers are not consistent here: a MySQL TEXT column can arrive as a Buffer, and a
 * numeric-looking column can arrive as a number. `String(value)` would quietly turn an
 * object into "[object Object]" and store that in the entity, so anything unexpected
 * fails loudly instead.
 */
function toText(value: unknown, field: string): string {
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  throw new QueryError(
    `Field "${field}" is declared string but the driver returned ${describe(value)}`,
  );
}

function toSafeInteger(value: unknown, field: string): number {
  const n =
    typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : Number(value);

  if (!Number.isSafeInteger(n)) {
    throw new QueryError(
      `Field "${field}" holds ${String(value)}, which is outside the safe integer range ` +
        `and cannot be represented as a JS number without losing precision.`,
    );
  }
  return n;
}

/** One field's name, column, and type, resolved once instead of per row. */
interface RowPlanEntry {
  field: string;
  column: string;
  type: FieldType;
}

/**
 * Cached per schema.
 *
 * Row mapping is the hottest path in the package: it runs once per field per row on every
 * read. Resolving the column and type through the schema's lookup tables each time cost
 * three dictionary reads per field, and hoisting them out is worth about 10 percent of the
 * mapping cost on a ten-column row. A schema is frozen at definition time, so the plan
 * cannot go stale.
 */
const rowPlans = new WeakMap<Schema, RowPlanEntry[]>();

function rowPlan(schema: Schema): RowPlanEntry[] {
  let plan = rowPlans.get(schema);
  if (plan === undefined) {
    plan = schema.fieldNames.map((field) => ({
      field,
      column: schema.columns[field] as string,
      type: schema.types[field] as FieldType,
    }));
    rowPlans.set(schema, plan);
  }
  return plan;
}

/** Maps a result row keyed by column name onto the application shape keyed by field name. */
export function rowToEntity<T>(row: Record<string, unknown>, schema: Schema, dialect: Dialect): T {
  const entity: Record<string, unknown> = {};
  const plan = rowPlan(schema);
  for (let i = 0; i < plan.length; i += 1) {
    const entry = plan[i] as RowPlanEntry;
    entity[entry.field] = fromDb(row[entry.column], entry.type, dialect, entry.field);
  }
  return entity as T;
}
