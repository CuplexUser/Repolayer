import { SchemaError } from './errors.js';

/**
 * The storage types repolayer knows how to normalize across engines. Deliberately small:
 * anything exotic is better expressed as `json` than as a dialect-specific column type.
 */
export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'json';

export interface FieldDef {
  type: FieldType;
  /** Column name in the database. Defaults to the field name. */
  column?: string;
  primaryKey?: boolean;
  nullable?: boolean;
  unique?: boolean;
  /** Applied by `ensureTable()` as a DDL default. Not applied client side. */
  default?: unknown;
}

export type FieldMap = Record<string, FieldDef>;

/** Maps a single field definition onto its TypeScript type. */
type FieldValue<F extends FieldDef> = F['type'] extends 'string'
  ? string
  : F['type'] extends 'number' | 'integer'
    ? number
    : F['type'] extends 'boolean'
      ? boolean
      : F['type'] extends 'date'
        ? Date
        : unknown;

type Nullable<F extends FieldDef, V> = F extends { nullable: true } ? V | null : V;

/**
 * The row type a schema describes. `nullable: true` fields widen to include `null`,
 * so the compiler tells you where to handle absent values.
 */
export type Infer<S> =
  S extends Schema<infer F> ? { [K in keyof F]: Nullable<F[K], FieldValue<F[K]>> } : never;

/** The insert shape: the primary key is optional when the adapter generates it. */
export type CreateInput<T, IdKey extends keyof T = keyof T> = Omit<T, IdKey> &
  Partial<Pick<T, IdKey>>;

/**
 * The default type argument is `any` on purpose. Runtime code (the compiler, the DDL
 * generator, both adapters) only ever reads the precomputed lookup tables and does not
 * care which fields a schema has, so a bare `Schema` accepts any concrete schema. The
 * type argument exists solely so `Infer<typeof mySchema>` can recover the row type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Schema<F extends FieldMap = any> {
  readonly fields: F;
  /** Field name of the single primary key. */
  readonly primaryKey: string & keyof F;
  /** Field name to column name. Precomputed so adapters never re-derive it per query. */
  readonly columns: Readonly<Record<string, string>>;
  /** Column name back to field name, for mapping result rows. */
  readonly fieldsByColumn: Readonly<Record<string, string>>;
  /** Stable field ordering, used by DDL generation and INSERT column lists. */
  readonly fieldNames: readonly (string & keyof F)[];
  /** Field name to type, the hot path for serialization. */
  readonly types: Readonly<Record<string, FieldType>>;
}

const VALID_TYPES = new Set<string>(['string', 'number', 'integer', 'boolean', 'date', 'json']);

/**
 * Validates a field map and precomputes the lookup tables both adapters use.
 *
 * Runtime validation happens once at definition time rather than per query, so a
 * malformed schema fails at module load rather than on a customer's first request.
 */
export function defineSchema<const F extends FieldMap>(fields: F): Schema<F> {
  const fieldNames = Object.keys(fields) as (string & keyof F)[];
  if (fieldNames.length === 0) {
    throw new SchemaError('A schema must define at least one field');
  }

  const columns: Record<string, string> = {};
  const fieldsByColumn: Record<string, string> = {};
  const types: Record<string, FieldType> = {};
  let primaryKey: (string & keyof F) | undefined;

  for (const name of fieldNames) {
    const def = fields[name] as FieldDef;

    if (!VALID_TYPES.has(def.type)) {
      throw new SchemaError(
        `Field "${name}" has unknown type ${JSON.stringify(def.type)}. ` +
          `Expected one of: ${[...VALID_TYPES].join(', ')}`,
      );
    }

    const column = def.column ?? name;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
      throw new SchemaError(
        `Field "${name}" maps to column ${JSON.stringify(column)}, which is not a plain ` +
          `identifier. Column names must match /^[A-Za-z_][A-Za-z0-9_]*$/ because repolayer ` +
          `never quotes-and-interpolates arbitrary text into SQL.`,
      );
    }
    if (column in fieldsByColumn) {
      throw new SchemaError(
        `Fields "${fieldsByColumn[column]}" and "${name}" both map to column "${column}"`,
      );
    }

    if (def.primaryKey) {
      if (primaryKey !== undefined) {
        throw new SchemaError(
          `Schema declares two primary keys ("${primaryKey}" and "${name}"). ` +
            `repolayer supports single-column primary keys only.`,
        );
      }
      if (def.nullable) {
        throw new SchemaError(`Primary key "${name}" cannot be nullable`);
      }
      primaryKey = name;
    }

    columns[name] = column;
    fieldsByColumn[column] = name;
    types[name] = def.type;
  }

  if (primaryKey === undefined) {
    throw new SchemaError(
      'Schema has no primary key. Mark exactly one field with `primaryKey: true`.',
    );
  }

  return Object.freeze({
    fields,
    primaryKey,
    columns: Object.freeze(columns),
    fieldsByColumn: Object.freeze(fieldsByColumn),
    fieldNames: Object.freeze(fieldNames),
    types: Object.freeze(types),
  });
}

/** Resolves a field name to its column, or throws if the field is not in the schema. */
export function columnFor(schema: Schema, field: string, context: string): string {
  const column = schema.columns[field];
  if (column === undefined) {
    throw new SchemaError(
      `Unknown field "${field}" in ${context}. Known fields: ${schema.fieldNames.join(', ')}`,
    );
  }
  return column;
}
