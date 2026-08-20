import type { Dialect } from './dialect.js';
import { QueryError } from './errors.js';
import type { FieldType, Schema } from './schema.js';

/**
 * The single place where the two engines are allowed to store the same value differently.
 *
 *   type      SQLite                              Postgres
 *   -------   ---------------------------------   ------------------------
 *   string    TEXT                                TEXT
 *   number    REAL                                DOUBLE PRECISION
 *   integer   INTEGER                             BIGINT
 *   boolean   INTEGER 0/1                         BOOLEAN
 *   date      TEXT, ISO-8601 UTC, fixed width     TIMESTAMPTZ
 *   json      TEXT via JSON.stringify             JSONB
 *
 * Application code never sees the difference: `toDb`/`fromDb` round trip real `Date`
 * objects, real booleans, and real numbers on both engines.
 */

function fail(field: string, type: FieldType, value: unknown): never {
  throw new QueryError(
    `Field "${field}" is declared ${type} but received ${describe(value)}`,
  );
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Date) return 'a Date';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/** Converts one application value into the representation its column expects. */
export function toDb(
  value: unknown,
  type: FieldType,
  dialect: Dialect,
  field: string,
): unknown {
  if (value === null || value === undefined) return null;

  switch (type) {
    case 'string':
      if (typeof value !== 'string') fail(field, type, value);
      return value;

    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(field, type, value);
      return value;

    case 'integer':
      if (typeof value === 'bigint') return dialect === 'postgres' ? value.toString() : value;
      if (typeof value !== 'number' || !Number.isInteger(value)) fail(field, type, value);
      return value;

    case 'boolean':
      if (typeof value !== 'boolean') fail(field, type, value);
      // SQLite has no boolean type: 0/1 keeps comparisons and ORDER BY sane.
      return dialect === 'sqlite' ? (value ? 1 : 0) : value;

    case 'date': {
      if (!(value instanceof Date) || Number.isNaN(value.getTime())) fail(field, type, value);
      // Fixed-width ISO-8601 in UTC, so lexicographic TEXT ordering in SQLite matches
      // chronological ordering in Postgres.
      return dialect === 'sqlite' ? value.toISOString() : value;
    }

    case 'json':
      // Always stringify ourselves. Letting the driver infer would send a bare string
      // value as text, which Postgres then refuses to cast to jsonb.
      return JSON.stringify(value ?? null);
  }
}

/** Converts one database value back into its application representation. */
export function fromDb(
  value: unknown,
  type: FieldType,
  dialect: Dialect,
  field: string,
): unknown {
  if (value === null || value === undefined) return null;

  switch (type) {
    case 'string':
      return typeof value === 'string' ? value : String(value);

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
      return new Date(value as string | number);

    case 'json':
      // Postgres drivers already parse jsonb into a JS value; SQLite hands back TEXT.
      // Parsing the Postgres result again would corrupt a legitimately stored string.
      if (dialect === 'postgres') return value;
      return typeof value === 'string' ? JSON.parse(value) : value;
  }
}

function toSafeInteger(value: unknown, field: string): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'bigint'
        ? Number(value)
        : Number(value as string);

  if (!Number.isSafeInteger(n)) {
    throw new QueryError(
      `Field "${field}" holds ${String(value)}, which is outside the safe integer range ` +
        `and cannot be represented as a JS number without losing precision.`,
    );
  }
  return n;
}

/** Maps a result row keyed by column name onto the application shape keyed by field name. */
export function rowToEntity<T>(row: Record<string, unknown>, schema: Schema, dialect: Dialect): T {
  const entity: Record<string, unknown> = {};
  for (const field of schema.fieldNames) {
    const column = schema.columns[field] as string;
    entity[field] = fromDb(row[column], schema.types[field] as FieldType, dialect, field);
  }
  return entity as T;
}
