import type { Dialect } from './dialect.js';
import { QueryError } from './errors.js';
import type { FieldType, Schema } from './schema.js';
import { toDb } from './serialize.js';

export type Operator =
  'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'like' | 'ilike' | 'isNull';

export interface FieldFilter<T> {
  field: keyof T & string;
  op: Operator;
  value?: unknown;
}

/** Every filter in the group must match. */
export interface AndGroup<T> {
  and: Filter<T>[];
}

/** At least one filter in the group must match. */
export interface OrGroup<T> {
  or: Filter<T>[];
}

/**
 * One node of a filter tree: a field comparison, or a group of them.
 *
 * Groups are what let a query say "A and (B or C)" without a query builder DSL and without
 * leaving the serializable shape: a filter tree is still plain JSON, so it survives an HTTP
 * boundary, a queue, or a config file unchanged.
 */
export type Filter<T> = FieldFilter<T> | AndGroup<T> | OrGroup<T>;

export interface OrderBy<T> {
  field: keyof T & string;
  direction: 'asc' | 'desc';
}

export interface QueryOptions<T> {
  /** Object form is an implicit AND of equality checks; array form an implicit AND. */
  where?: Partial<T> | Filter<T>[];
  orderBy?: OrderBy<T>[];
  limit?: number;
  offset?: number;
}

/**
 * How deep a filter tree may nest.
 *
 * A tree usually arrives from application code, but it is serializable by design, which
 * means it can also arrive from an HTTP request. A bound depth is what stops a hostile or
 * merely buggy caller from turning one request into unbounded SQL.
 */
const MAX_FILTER_DEPTH = 16;

/** Exported so a non-SQL adapter can reject exactly the operators the compiler rejects. */
export const OPERATORS = new Set<string>([
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

/**
 * Collation forced onto a `like` comparison on MySQL.
 *
 * MySQL and MariaDB decide LIKE case sensitivity by collation, and the server default is
 * case insensitive, which would make `like` and `ilike` mean the same thing. Naming a
 * binary collation on the pattern makes `like` case sensitive whatever the column was
 * created with. `ensureTable` creates string columns with this same collation, so the
 * comparison stays index friendly on tables repolayer made.
 */
const MYSQL_BINARY_COLLATION = 'utf8mb4_bin';

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

/**
 * Reads either accepted `where` form into a flat list of filter nodes. Exported because
 * `findPage` has to append the keyset predicate to whatever the caller passed.
 */
export function normalizeWhere<T>(where: QueryOptions<T>['where']): Filter<T>[] {
  if (where === undefined) return [];
  if (Array.isArray(where)) return where;
  return Object.entries(where).map(([field, value]) => ({
    field: field as keyof T & string,
    op: 'eq' as const,
    value,
  }));
}

function isAndGroup<T>(node: Filter<T>): node is AndGroup<T> {
  return Array.isArray((node as AndGroup<T>).and);
}

function isOrGroup<T>(node: Filter<T>): node is OrGroup<T> {
  return Array.isArray((node as OrGroup<T>).or);
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
  if (typeof op !== 'string') {
    throw new QueryError(
      `Filter on field "${String(field)}" has no operator. A filter node is either ` +
        `{ field, op, value }, { and: [...] }, or { or: [...] }.`,
    );
  }

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
      if (op === 'like') {
        return dialect === 'mysql'
          ? `${column} LIKE ${placeholder} COLLATE ${MYSQL_BINARY_COLLATION}`
          : `${column} LIKE ${placeholder}`;
      }
      // Postgres has ILIKE. Everywhere else, lowering both sides is what produces the same
      // meaning, and on MySQL it also overrides whatever collation the column carries.
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

/**
 * Compiles one node of a filter tree: a group, or a single field comparison.
 *
 * An empty group collapses to a constant rather than to invalid SQL, the same convention
 * an empty `in` or `nin` already follows: an empty AND matches everything (nothing has
 * been excluded), an empty OR matches nothing (no alternative was offered).
 */
function compileNode<T>(
  node: Filter<T>,
  schema: Schema,
  dialect: Dialect,
  params: ParamList,
  depth: number,
): string {
  if (depth > MAX_FILTER_DEPTH) {
    throw new QueryError(
      `Filter tree is nested deeper than ${MAX_FILTER_DEPTH} levels. Flatten it, or filter ` +
        `in application code: an unbounded tree compiles to unbounded SQL.`,
    );
  }

  if (isAndGroup(node)) return compileGroup(node.and, 'AND', schema, dialect, params, depth);
  if (isOrGroup(node)) return compileGroup(node.or, 'OR', schema, dialect, params, depth);
  return compileFilter(node, schema, dialect, params);
}

function compileGroup<T>(
  nodes: Filter<T>[],
  joiner: 'AND' | 'OR',
  schema: Schema,
  dialect: Dialect,
  params: ParamList,
  depth: number,
): string {
  if (nodes.length === 0) return joiner === 'AND' ? '1 = 1' : '1 = 0';
  const parts = nodes.map((child) => compileNode(child, schema, dialect, params, depth + 1));
  // Always parenthesized: an unparenthesized OR inside an AND would silently change which
  // rows match, and that is the kind of bug that only shows up in production data.
  return parts.length === 1 ? (parts[0] as string) : `(${parts.join(` ${joiner} `)})`;
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
  const clauses = filters.map((f) => compileNode(f, schema, dialect, params, 0));
  return ` WHERE ${clauses.join(' AND ')}`;
}

/**
 * Builds `ORDER BY`, always with an explicit null position.
 *
 * Left to their defaults the engines disagree: Postgres sorts NULLs last on ASC, SQLite
 * sorts them first, MySQL sorts them first. Stating the position explicitly is what keeps
 * a paged result set identical after a driver swap. SQLite has supported the NULLS
 * FIRST/LAST syntax since 3.30; MySQL has no such syntax at all, so the same position is
 * produced by sorting on the nullness first.
 */
export function compileOrderBy<T>(
  orderBy: OrderBy<T>[] | undefined,
  schema: Schema,
  dialect: Dialect = 'sqlite',
): string {
  if (orderBy === undefined || orderBy.length === 0) return '';

  const parts = orderBy.map(({ field, direction }) => {
    if (direction !== 'asc' && direction !== 'desc') {
      throw new QueryError(
        `Invalid sort direction ${JSON.stringify(direction)} on field "${String(field)}". ` +
          `Expected "asc" or "desc".`,
      );
    }
    const column = columnOf(schema, field, 'orderBy');
    const order = direction.toUpperCase();

    if (dialect === 'mysql') {
      // `(col IS NULL)` is 0 for a value and 1 for a null, so sorting it ASC puts nulls
      // last and DESC puts them first, which is exactly what NULLS LAST/FIRST mean.
      return `(${column} IS NULL) ${order}, ${column} ${order}`;
    }

    const nulls = direction === 'asc' ? 'NULLS LAST' : 'NULLS FIRST';
    return `${column} ${order} ${nulls}`;
  });

  return ` ORDER BY ${parts.join(', ')}`;
}

/**
 * Builds `LIMIT`/`OFFSET`.
 *
 * An `offset` with no `limit` is the one case the dialects all spell differently. SQLite
 * requires a LIMIT before OFFSET and uses -1 for "unbounded", Postgres rejects a negative
 * LIMIT and spells it `LIMIT ALL`, and MySQL accepts neither and wants the largest
 * possible unsigned integer, which is the spelling its own documentation recommends.
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
    if (query.limit === undefined) sql += unboundedLimit(dialect);
    sql += ` OFFSET ${params.add(query.offset)}`;
  }
  return sql;
}

/** Shared by the compiler and by MemoryRepo, so both reject the same values the same way. */
export function unboundedLimit(dialect: Dialect): string {
  if (dialect === 'postgres') return ' LIMIT ALL';
  // 2^64 - 1, the documented MySQL idiom for "everything from here on".
  if (dialect === 'mysql') return ' LIMIT 18446744073709551615';
  return ' LIMIT -1';
}

/** Shared by the compiler and by MemoryRepo, so both reject the same values the same way. */
export function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new QueryError(`${name} must be a non-negative integer, received ${String(value)}`);
  }
}

/**
 * Cached per schema. A schema is frozen at definition time, so the column list it produces
 * can never change, and rebuilding it on every query was measurably the most wasteful
 * thing the compiler did: memoizing it is roughly nine times faster per call.
 */
const selectLists = new WeakMap<Schema, string>();

/** The explicit column list, so `SELECT *` never surprises us with drifted columns. */
export function selectList(schema: Schema): string {
  let list = selectLists.get(schema);
  if (list === undefined) {
    list = schema.fieldNames.map((f) => schema.columns[f]).join(', ');
    selectLists.set(schema, list);
  }
  return list;
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
    compileOrderBy(q.orderBy, schema, dialect) +
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
