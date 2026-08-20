import type { Dialect } from './dialect.js';
import { QueryError } from './errors.js';
import type { FieldType, Schema } from './schema.js';
import { toDb } from './serialize.js';

export type Operator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'nin'
  | 'like'
  | 'ilike'
  | 'isNull';

export interface FieldFilter<T> {
  field: keyof T & string;
  op: Operator;
  value?: unknown;
}

export interface OrderBy<T> {
  field: keyof T & string;
  direction: 'asc' | 'desc';
}

export interface QueryOptions<T> {
  /** Object form is an implicit AND of equality checks. */
  where?: Partial<T> | FieldFilter<T>[];
  orderBy?: OrderBy<T>[];
  limit?: number;
  offset?: number;
}

const OPERATORS = new Set<string>([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'nin',
  'like',
  'ilike',
  'isNull',
]);

/** Accumulates parameters and renders the placeholder each dialect expects. */
export class ParamList {
  readonly values: unknown[] = [];

  constructor(private readonly dialect: Dialect) {}

  add(value: unknown): string {
    this.values.push(value);
    return this.dialect === 'postgres' ? `$${this.values.length}` : '?';
  }
}

export interface CompiledQuery {
  sql: string;
  params: unknown[];
}

function normalizeWhere<T>(where: QueryOptions<T>['where']): FieldFilter<T>[] {
  if (where === undefined) return [];
  if (Array.isArray(where)) return where;
  return Object.entries(where).map(([field, value]) => ({
    field: field as keyof T & string,
    op: 'eq' as const,
    value,
  }));
}

function columnOf(schema: Schema, field: string, context: string): string {
  const column = schema.columns[field];
  if (column === undefined) {
    throw new QueryError(
      `Unknown field "${field}" in ${context}. Known fields: ${schema.fieldNames.join(', ')}`,
    );
  }
  return column;
}

/**
 * Compiles one filter into SQL. The cross-engine normalizations live here:
 *
 *  - `like` is case sensitive and `ilike` is not, on both engines. The SQLite adapter
 *    sets `PRAGMA case_sensitive_like = ON` at connection open so LIKE means what it
 *    says, and `ilike` lowers both sides.
 *  - `in` with an empty array is a constant false rather than invalid SQL, and `nin`
 *    with an empty array is a constant true.
 *  - `ne` and `nin` keep NULL rows in the result, which raw SQL would silently drop.
 *  - The column always comes from the schema and the value is always a bound parameter,
 *    so no caller-supplied text is ever interpolated into SQL.
 */
function compileFilter<T>(
  filter: FieldFilter<T>,
  schema: Schema,
  dialect: Dialect,
  params: ParamList,
): string {
  const { field, op } = filter;

  if (!OPERATORS.has(op)) {
    throw new QueryError(
      `Unknown operator ${JSON.stringify(op)} on field "${String(field)}". ` +
        `Supported operators: ${[...OPERATORS].join(', ')}`,
    );
  }

  const column = columnOf(schema, field, 'where');
  const type = schema.types[field] as FieldType;
  const bind = (value: unknown): string => params.add(toDb(value, type, dialect, field));

  switch (op) {
    case 'eq':
      // `eq: null` means IS NULL. `= NULL` is never true in SQL, and silently matching
      // nothing would be a trap rather than a feature.
      return filter.value === null || filter.value === undefined
        ? `${column} IS NULL`
        : `${column} = ${bind(filter.value)}`;

    case 'ne':
      return filter.value === null || filter.value === undefined
        ? `${column} IS NOT NULL`
        : `(${column} <> ${bind(filter.value)} OR ${column} IS NULL)`;

    case 'gt':
      return `${column} > ${bind(filter.value)}`;
    case 'gte':
      return `${column} >= ${bind(filter.value)}`;
    case 'lt':
      return `${column} < ${bind(filter.value)}`;
    case 'lte':
      return `${column} <= ${bind(filter.value)}`;

    case 'in':
    case 'nin': {
      if (!Array.isArray(filter.value)) {
        throw new QueryError(
          `Operator "${op}" on field "${String(field)}" requires an array value, received ` +
            `${filter.value === undefined ? 'undefined' : typeof filter.value}`,
        );
      }
      if (filter.value.length === 0) {
        // `IN ()` is a syntax error in both dialects, so collapse to a constant.
        return op === 'in' ? '1 = 0' : '1 = 1';
      }
      const placeholders = filter.value.map(bind).join(', ');
      return op === 'in'
        ? `${column} IN (${placeholders})`
        : `(${column} NOT IN (${placeholders}) OR ${column} IS NULL)`;
    }

    case 'like':
    case 'ilike': {
      if (typeof filter.value !== 'string') {
        throw new QueryError(
          `Operator "${op}" on field "${String(field)}" requires a string pattern`,
        );
      }
      const placeholder = params.add(filter.value);
      if (op === 'like') return `${column} LIKE ${placeholder}`;
      return dialect === 'postgres'
        ? `${column} ILIKE ${placeholder}`
        : `LOWER(${column}) LIKE LOWER(${placeholder})`;
    }

    case 'isNull': {
      const wantNull = filter.value === undefined ? true : Boolean(filter.value);
      return wantNull ? `${column} IS NULL` : `${column} IS NOT NULL`;
    }
  }

  /* c8 ignore next */
  throw new QueryError(`Unhandled operator ${JSON.stringify(op)}`);
}

/** Builds the `WHERE ...` clause, or an empty string when there are no filters. */
export function compileWhere<T>(
  where: QueryOptions<T>['where'],
  schema: Schema,
  dialect: Dialect,
  params: ParamList,
): string {
  const filters = normalizeWhere(where);
  if (filters.length === 0) return '';
  const clauses = filters.map((f) => compileFilter(f, schema, dialect, params));
  return ` WHERE ${clauses.join(' AND ')}`;
}

/**
 * Builds `ORDER BY`, always with an explicit null position.
 *
 * Left to their defaults the engines disagree: Postgres sorts NULLs last on ASC, SQLite
 * sorts them first. Stating the position explicitly is what keeps a paged result set
 * identical after a driver swap. SQLite has supported this syntax since 3.30.
 */
export function compileOrderBy<T>(orderBy: OrderBy<T>[] | undefined, schema: Schema): string {
  if (orderBy === undefined || orderBy.length === 0) return '';

  const parts = orderBy.map(({ field, direction }) => {
    if (direction !== 'asc' && direction !== 'desc') {
      throw new QueryError(
        `Invalid sort direction ${JSON.stringify(direction)} on field "${String(field)}". ` +
          `Expected "asc" or "desc".`,
      );
    }
    const column = columnOf(schema, field, 'orderBy');
    const nulls = direction === 'asc' ? 'NULLS LAST' : 'NULLS FIRST';
    return `${column} ${direction.toUpperCase()} ${nulls}`;
  });

  return ` ORDER BY ${parts.join(', ')}`;
}

/**
 * Builds `LIMIT`/`OFFSET`.
 *
 * An `offset` with no `limit` is the one case the two dialects spell differently. SQLite
 * requires a LIMIT clause before OFFSET and uses -1 for "unbounded", while Postgres
 * rejects a negative LIMIT outright and spells the same thing `LIMIT ALL`.
 */
export function compileLimit<T>(
  query: QueryOptions<T>,
  params: ParamList,
  dialect: Dialect,
): string {
  let sql = '';
  if (query.limit !== undefined) {
    assertNonNegativeInteger(query.limit, 'limit');
    sql += ` LIMIT ${params.add(query.limit)}`;
  }
  if (query.offset !== undefined) {
    assertNonNegativeInteger(query.offset, 'offset');
    if (query.limit === undefined) sql += dialect === 'postgres' ? ' LIMIT ALL' : ' LIMIT -1';
    sql += ` OFFSET ${params.add(query.offset)}`;
  }
  return sql;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new QueryError(`${name} must be a non-negative integer, received ${String(value)}`);
  }
}

/** The explicit column list, so `SELECT *` never surprises us with drifted columns. */
export function selectList(schema: Schema): string {
  return schema.fieldNames.map((f) => schema.columns[f]).join(', ');
}

/** Compiles a full SELECT for the given table. */
export function compileSelect<T>(
  schema: Schema,
  table: string,
  query: QueryOptions<T> | undefined,
  dialect: Dialect,
): CompiledQuery {
  const params = new ParamList(dialect);
  const q = query ?? {};
  const sql =
    `SELECT ${selectList(schema)} FROM ${table}` +
    compileWhere(q.where, schema, dialect, params) +
    compileOrderBy(q.orderBy, schema) +
    compileLimit(q, params, dialect);
  return { sql, params: params.values };
}

/** Compiles `SELECT COUNT(*)`, which ignores ordering but honors filters. */
export function compileCount<T>(
  schema: Schema,
  table: string,
  query: QueryOptions<T> | undefined,
  dialect: Dialect,
): CompiledQuery {
  const params = new ParamList(dialect);
  const sql =
    `SELECT COUNT(*) AS count FROM ${table}` + compileWhere(query?.where, schema, dialect, params);
  return { sql, params: params.values };
}
