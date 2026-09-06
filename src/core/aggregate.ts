import type { Dialect } from './dialect.js';
import { QueryError } from './errors.js';
import {
  assertNonNegativeInteger,
  compileLimit,
  compileWhere,
  orderByClause,
  ParamList,
  type CompiledQuery,
  type OrderTerm,
  type QueryOptions,
} from './query.js';
import { columnFor, type FieldType, type Schema } from './schema.js';
import { fromDb, toDb } from './serialize.js';

/**
 * Grouping and aggregation, in the same serializable shape the rest of `QueryOptions` uses.
 *
 * This is the one read that does not return entities: a grouped query answers a question
 * about a set of rows rather than handing back the rows themselves, so it returns plain
 * records keyed by the group fields and by the aggregate aliases the caller named.
 *
 * The work here is the same work the filter compiler does, for the same reason. Left to
 * themselves the engines disagree about the type an aggregate comes back as, about the
 * precision of an average, and about how a value is compared when it is grouped. Every one
 * of those is normalized here, so a report that was right on SQLite is still right on
 * Postgres.
 */

export type AggregateFn = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface Aggregate<T = unknown> {
  fn: AggregateFn;
  /** Required by every function except `count`, which counts rows when it is omitted. */
  field?: keyof T & string;
  /** Counts, sums, or averages each distinct value once. Rejected on `min` and `max`. */
  distinct?: boolean;
}

/** Alias to aggregate. The alias is the key the result record carries the value under. */
export type AggregateMap<T> = Record<string, Aggregate<T>>;

/** The operators `having` accepts: a subset of the filter operators, with no patterns. */
export type HavingOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'isNull';

/** A filter on an aggregated value rather than on a row. */
export interface HavingFilter {
  /** Names one of the aliases in `aggregates`. */
  alias: string;
  op: HavingOperator;
  value?: unknown;
}

/** Ordering for a grouped result: by a `groupBy` field, or by an aggregate alias. */
export interface AggregateOrderBy {
  field: string;
  direction: 'asc' | 'desc';
}

export interface AggregateQuery<
  T,
  A extends AggregateMap<T> = AggregateMap<T>,
  G extends keyof T & string = keyof T & string,
> {
  /** Filters rows before they are grouped, exactly as it does everywhere else. */
  where?: QueryOptions<T>['where'];
  /** Omitting it aggregates the whole filtered set into a single row. */
  groupBy?: readonly G[];
  aggregates: A;
  /** Filters groups after they are formed. */
  having?: readonly HavingFilter[];
  orderBy?: readonly AggregateOrderBy[];
  limit?: number;
  offset?: number;
}

/** The value type one aggregate produces, so a result record types itself. */
type AggregateValue<T, S> = S extends { fn: 'count' }
  ? number
  : S extends { fn: 'min' | 'max'; field: infer F }
    ? F extends keyof T
      ? T[F] | null
      : unknown
    : number | null;

/**
 * One row of a grouped result: the group fields at their entity types, plus one property
 * per alias. `Pick<T, never>` is `{}`, so an ungrouped query types as aggregates only.
 */
export type AggregateRow<T, G extends keyof T & string, A extends AggregateMap<T>> = Pick<T, G> & {
  [K in keyof A]: AggregateValue<T, A[K]>;
};

const AGGREGATE_FNS = new Set<string>(['count', 'sum', 'avg', 'min', 'max']);
const HAVING_OPERATORS = new Set<string>(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'isNull']);

/** Aliases are interpolated into SQL, so they are held to the same shape as a column name. */
const ALIAS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What `sum` and `avg` accept. Averaging a date or a boolean is a mistake, not a feature. */
const NUMERIC_TYPES = new Set<FieldType>(['number', 'integer']);

/**
 * What `groupBy`, `distinct`, and `min`/`max` accept.
 *
 * `json` is excluded on purpose. Postgres stores it as `jsonb`, which compares and orders
 * normalized documents, while SQLite and MySQL store the exact text `toDb` produced and
 * compare that. Two engines would put the same rows in different groups, which is the one
 * thing this package exists to prevent. Group in application code, or store the part you
 * group by as its own column.
 */
const GROUPABLE_TYPES = new Set<FieldType>(['string', 'number', 'integer', 'date', 'boolean']);

/**
 * What `min` and `max` accept: the groupable types, less `boolean`.
 *
 * Postgres has no `min(boolean)` at all, while SQLite and MySQL store a boolean as 0 or 1
 * and will happily order it. Rejecting it here turns an error that only one engine would
 * have raised, at runtime, into the same `QueryError` everywhere.
 */
const ORDERABLE_TYPES = new Set<FieldType>(['string', 'number', 'integer', 'date']);

/** One resolved aggregate: the alias, what it computes, and the type it reads back as. */
export interface AggregateTerm {
  alias: string;
  fn: AggregateFn;
  /** Null only for `count` over rows. */
  field: string | null;
  column: string | null;
  distinct: boolean;
  /** The declared type the result value is deserialized as. */
  type: FieldType;
}

/** One resolved group key. */
export interface GroupTerm {
  field: string;
  column: string;
  type: FieldType;
}

export interface HavingTerm {
  term: AggregateTerm;
  op: HavingOperator;
  value: unknown;
}

export interface AggregateOrderTerm {
  /** Exactly one of these two is set. */
  group: GroupTerm | null;
  term: AggregateTerm | null;
  direction: 'asc' | 'desc';
}

/**
 * A validated aggregate query, with every name already resolved to a column and a type.
 *
 * Planning is separated from rendering because `MemoryRepo` needs the validation and the
 * resolution but has no SQL to render. Sharing the plan is what keeps it from growing a
 * second, subtly different opinion about which queries are legal, which is exactly the
 * drift the conformance suite exists to catch.
 */
export interface AggregatePlan {
  groups: GroupTerm[];
  terms: AggregateTerm[];
  having: HavingTerm[];
  orderBy: AggregateOrderTerm[];
}

function assertGroupable(schema: Schema, field: string, context: string): GroupTerm {
  const column = columnFor(schema, field, context, QueryError);
  const type = schema.types[field] as FieldType;
  if (!GROUPABLE_TYPES.has(type)) {
    throw new QueryError(
      `Field "${field}" is declared ${type} and cannot be used in ${context}. Postgres ` +
        `normalizes a json value and the other engines store it verbatim, so the engines ` +
        `would not agree on which values are the same one.`,
    );
  }
  return { field, column, type };
}

/** Resolves and validates group keys, rejecting duplicates and unusable types. */
function planGroups(
  schema: Schema,
  fields: readonly string[] | undefined,
  context: string,
): GroupTerm[] {
  if (fields === undefined) return [];
  if (!Array.isArray(fields)) {
    throw new QueryError(`${context} must be an array of field names.`);
  }

  const groups: GroupTerm[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    if (typeof field !== 'string') {
      throw new QueryError(`${context} must be an array of field names.`);
    }
    if (seen.has(field)) {
      throw new QueryError(`Field "${field}" is named twice in ${context}.`);
    }
    seen.add(field);
    groups.push(assertGroupable(schema, field, context));
  }
  return groups;
}

/** Resolves one alias into the term that computes it. */
function planTerm<T>(schema: Schema, alias: string, spec: Aggregate<T>): AggregateTerm {
  if (!ALIAS_PATTERN.test(alias)) {
    throw new QueryError(
      `Aggregate alias ${JSON.stringify(alias)} is not a plain identifier. Aliases must match ` +
        `/^[A-Za-z_][A-Za-z0-9_]*$/, because repolayer never quotes-and-interpolates ` +
        `arbitrary text into SQL.`,
    );
  }

  const fn = spec?.fn;
  if (typeof fn !== 'string' || !AGGREGATE_FNS.has(fn)) {
    throw new QueryError(
      `Unknown aggregate ${JSON.stringify(fn)} for alias "${alias}". ` +
        `Supported aggregates: ${[...AGGREGATE_FNS].join(', ')}`,
    );
  }

  const field = spec.field;
  const distinct = spec.distinct === true;

  if (field === undefined) {
    if (fn !== 'count') {
      throw new QueryError(
        `Aggregate "${fn}" on alias "${alias}" needs a field. Only "count" can be taken over ` +
          `rows rather than over a column.`,
      );
    }
    if (distinct) {
      throw new QueryError(
        `Alias "${alias}" asks for a distinct count with no field. Name the field whose ` +
          `distinct values should be counted.`,
      );
    }
    return { alias, fn, field: null, column: null, distinct: false, type: 'integer' };
  }

  const column = columnFor(schema, field, `aggregate "${alias}"`, QueryError);
  const type = schema.types[field] as FieldType;

  if ((fn === 'sum' || fn === 'avg') && !NUMERIC_TYPES.has(type)) {
    throw new QueryError(
      `Aggregate "${fn}" on alias "${alias}" needs a number or integer field, but "${field}" ` +
        `is declared ${type}.`,
    );
  }
  if ((fn === 'min' || fn === 'max') && !ORDERABLE_TYPES.has(type)) {
    throw new QueryError(
      `Aggregate "${fn}" on alias "${alias}" cannot be taken over "${field}", which is ` +
        `declared ${type}. Postgres has no minimum of a boolean and no engine-independent ` +
        `ordering of a json value: group by the field instead, or compare in application code.`,
    );
  }
  if ((fn === 'min' || fn === 'max') && distinct) {
    throw new QueryError(
      `Alias "${alias}" asks for a distinct ${fn}, which cannot mean anything: the smallest ` +
        `and largest values of a set do not change when its duplicates are removed.`,
    );
  }
  if (fn === 'count' && distinct && !GROUPABLE_TYPES.has(type)) {
    throw new QueryError(
      `Alias "${alias}" counts distinct values of "${field}", which is declared ${type}. ` +
        `Only Postgres normalizes a json value, so the engines would not agree on how many ` +
        `distinct ones there are.`,
    );
  }

  // A count is a count whatever it counts, an average is always a double, and `sum`, `min`,
  // and `max` come back as the field's own type, so a min over a date is still a Date.
  const resultType: FieldType = fn === 'count' ? 'integer' : fn === 'avg' ? 'number' : type;
  return { alias, fn, field, column, distinct, type: resultType };
}

function planTerms<T>(
  schema: Schema,
  aggregates: AggregateMap<T> | undefined,
  groups: GroupTerm[],
): AggregateTerm[] {
  if (aggregates === undefined || aggregates === null || typeof aggregates !== 'object') {
    throw new QueryError(
      'An aggregate query needs an `aggregates` object mapping each alias to an aggregate.',
    );
  }

  const terms = Object.keys(aggregates).map((alias) =>
    planTerm(schema, alias, aggregates[alias] as Aggregate<T>),
  );

  if (terms.length === 0 && groups.length === 0) {
    throw new QueryError(
      'An aggregate query needs at least one aggregate, or a groupBy. An empty query has ' +
        'nothing to select.',
    );
  }

  // Postgres folds an unquoted alias to lower case, so two aliases differing only in case,
  // or an alias shadowing a group column, would arrive as one key in the result row and
  // silently lose a value.
  const taken = new Map<string, string>();
  for (const group of groups) taken.set(group.column.toLowerCase(), `the "${group.field}" group`);
  for (const term of terms) {
    const key = term.alias.toLowerCase();
    const owner = taken.get(key);
    if (owner !== undefined) {
      throw new QueryError(
        `Aggregate alias "${term.alias}" collides with ${owner}. Names in a grouped result ` +
          `must differ by more than case, because Postgres folds unquoted identifiers to ` +
          `lower case.`,
      );
    }
    taken.set(key, `the "${term.alias}" aggregate`);
  }

  return terms;
}

function planHaving(
  having: readonly HavingFilter[] | undefined,
  terms: AggregateTerm[],
): HavingTerm[] {
  if (having === undefined) return [];

  const byAlias = new Map(terms.map((term) => [term.alias, term] as const));
  return having.map((filter) => {
    const term = byAlias.get(filter?.alias);
    if (term === undefined) {
      throw new QueryError(
        `having names "${String(filter?.alias)}", which is not one of the aggregates. ` +
          `Known aliases: ${terms.map((t) => t.alias).join(', ') || '(none)'}. A condition on ` +
          `a column belongs in where, which is applied before the rows are grouped.`,
      );
    }
    if (typeof filter.op !== 'string' || !HAVING_OPERATORS.has(filter.op)) {
      throw new QueryError(
        `Unknown operator ${JSON.stringify(filter.op)} on having alias "${term.alias}". ` +
          `Supported operators: ${[...HAVING_OPERATORS].join(', ')}`,
      );
    }
    return { term, op: filter.op, value: filter.value };
  });
}

function planOrderBy(
  orderBy: readonly AggregateOrderBy[] | undefined,
  groups: GroupTerm[],
  terms: AggregateTerm[],
): AggregateOrderTerm[] {
  if (orderBy === undefined) return [];

  const byField = new Map(groups.map((group) => [group.field, group] as const));
  const byAlias = new Map(terms.map((term) => [term.alias, term] as const));

  return orderBy.map(({ field, direction }) => {
    if (direction !== 'asc' && direction !== 'desc') {
      throw new QueryError(
        `Invalid sort direction ${JSON.stringify(direction)} on "${String(field)}". ` +
          `Expected "asc" or "desc".`,
      );
    }
    const group = byField.get(field) ?? null;
    const term = group === null ? (byAlias.get(field) ?? null) : null;
    if (group === null && term === null) {
      const known = [...groups.map((g) => g.field), ...terms.map((t) => t.alias)];
      throw new QueryError(
        `Cannot order a grouped result by "${String(field)}": it is neither a groupBy field ` +
          `nor an aggregate alias. Known names: ${known.join(', ') || '(none)'}`,
      );
    }
    return { group, term, direction };
  });
}

/** Validates an aggregate query and resolves every name in it. Renders no SQL. */
export function planAggregate<T>(schema: Schema, query: AggregateQuery<T>): AggregatePlan {
  const groups = planGroups(schema, query?.groupBy, 'groupBy');
  const terms = planTerms(schema, query?.aggregates, groups);
  if (query.limit !== undefined) assertNonNegativeInteger(query.limit, 'limit');
  if (query.offset !== undefined) assertNonNegativeInteger(query.offset, 'offset');

  return {
    groups,
    terms,
    having: planHaving(query?.having, terms),
    orderBy: planOrderBy(query?.orderBy, groups, terms),
  };
}

/**
 * Renders one aggregate as SQL.
 *
 * The only function the engines spell differently is `avg`. Left alone, Postgres averages an
 * integer column as `numeric` and returns sixteen decimal places, MySQL returns a DECIMAL
 * with four, and SQLite returns a double, so the same rows produce three different numbers.
 * Averaging in double precision everywhere is what makes the answer one answer. Sums are
 * left exact, because widening one would lose digits nobody asked to lose.
 */
export function aggregateExpression(term: AggregateTerm, dialect: Dialect): string {
  if (term.fn === 'count' && term.column === null) return 'COUNT(*)';

  const distinct = term.distinct ? 'DISTINCT ' : '';
  const column = term.column as string;

  if (term.fn === 'avg') {
    if (dialect === 'postgres') return `AVG(${distinct}CAST(${column} AS DOUBLE PRECISION))`;
    // Adding a double literal is what promotes a MySQL DECIMAL average to a double, and a
    // NULL stays NULL, so an empty column is still excluded from the average rather than
    // counted as a zero.
    if (dialect === 'mysql') return `AVG(${distinct}${column} + 0e0)`;
    return `AVG(${distinct}${column})`;
  }

  return `${term.fn.toUpperCase()}(${distinct}${column})`;
}

/**
 * Renders `HAVING`, with the same NULL conventions the row filters use.
 *
 * The aggregate expression is repeated rather than referenced by alias: Postgres allows an
 * output name in `GROUP BY` and `ORDER BY` but not in `HAVING`, and repeating it is the one
 * spelling all three engines accept.
 */
function compileHaving(having: HavingTerm[], dialect: Dialect, params: ParamList): string {
  if (having.length === 0) return '';

  const parts = having.map(({ term, op, value }) => {
    const expr = aggregateExpression(term, dialect);
    const bind = (): string => params.add(toDb(value, term.type, dialect, term.alias));

    switch (op) {
      case 'isNull': {
        const wantNull = value === undefined ? true : Boolean(value);
        return wantNull ? `${expr} IS NULL` : `${expr} IS NOT NULL`;
      }
      case 'eq':
        return value === null || value === undefined ? `${expr} IS NULL` : `${expr} = ${bind()}`;
      case 'ne':
        // A sum over no values is NULL, and such a group is genuinely "not 5". Dropping it,
        // which raw SQL would, is the same trap `ne` on a column already avoids.
        return value === null || value === undefined
          ? `${expr} IS NOT NULL`
          : `(${expr} <> ${bind()} OR ${expr} IS NULL)`;
      case 'gt':
        return `${expr} > ${bind()}`;
      case 'gte':
        return `${expr} >= ${bind()}`;
      case 'lt':
        return `${expr} < ${bind()}`;
      default:
        return `${expr} <= ${bind()}`;
    }
  });

  return ` HAVING ${parts.join(' AND ')}`;
}

/** A compiled aggregate carries its plan, because its result rows cannot be read without it. */
export interface CompiledAggregate extends CompiledQuery {
  plan: AggregatePlan;
}

export function compileAggregate<T>(
  schema: Schema,
  table: string,
  query: AggregateQuery<T>,
  dialect: Dialect,
): CompiledAggregate {
  const plan = planAggregate(schema, query);
  const params = new ParamList(dialect);

  const projection = [
    ...plan.groups.map((group) => group.column),
    ...plan.terms.map((term) => `${aggregateExpression(term, dialect)} AS ${term.alias}`),
  ].join(', ');

  const groupBy =
    plan.groups.length === 0
      ? ''
      : ` GROUP BY ${plan.groups.map((group) => group.column).join(', ')}`;

  // Ordering repeats the aggregate expression rather than naming the alias, for the same
  // reason HAVING does: it is the one spelling every engine reads the same way.
  const order: OrderTerm[] = plan.orderBy.map(({ group, term, direction }) => ({
    expr: group === null ? aggregateExpression(term as AggregateTerm, dialect) : group.column,
    direction,
  }));

  const sql =
    `SELECT ${projection} FROM ${table}` +
    compileWhere(query.where, schema, dialect, params) +
    groupBy +
    compileHaving(plan.having, dialect, params) +
    orderByClause(order, dialect) +
    // Paging a grouped result pages the groups, so the limit is applied to the aggregate
    // rows rather than to the rows that were aggregated.
    compileLimit({ limit: query.limit, offset: query.offset }, params, dialect);

  return { sql, params: params.values, plan };
}

/**
 * Reads a result key the engine may have folded to lower case.
 *
 * Postgres lower-cases every unquoted identifier, so `SELECT ... AS totalWeight` arrives as
 * `totalweight`. Looking under both spellings is what lets an alias be written the way the
 * rest of the application is written, without quoting identifiers, which this package
 * deliberately never does.
 */
function readKey(row: Record<string, unknown>, name: string): unknown {
  if (name in row) return row[name];
  const lowered = name.toLowerCase();
  return lowered in row ? row[lowered] : null;
}

/** Maps the group keys of one result row back onto their entity types. */
export function groupValues(
  row: Record<string, unknown>,
  groups: GroupTerm[],
  dialect: Dialect,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const group of groups) {
    out[group.field] = fromDb(readKey(row, group.column), group.type, dialect, group.field);
  }
  return out;
}

/** Maps one result row onto its group values plus its aggregate values. */
export function aggregateRow(
  row: Record<string, unknown>,
  plan: AggregatePlan,
  dialect: Dialect,
): Record<string, unknown> {
  const out = groupValues(row, plan.groups, dialect);
  for (const term of plan.terms) {
    const raw = readKey(row, term.alias);
    if (term.fn === 'count') {
      // A count is never null, whatever the driver hands back for a bigint.
      out[term.alias] =
        raw === null || raw === undefined ? 0 : fromDb(raw, 'integer', dialect, term.alias);
      continue;
    }
    // Every other aggregate over no values is NULL on every engine, and stays null here
    // rather than being flattened to a zero that would read as a real measurement.
    out[term.alias] =
      raw === null || raw === undefined ? null : fromDb(raw, term.type, dialect, term.alias);
  }
  return out;
}

/**
 * Validates the fields of a `distinct` read.
 *
 * `orderBy` is checked against the selected fields rather than against the schema, because
 * the engines disagree about ordering a `SELECT DISTINCT` by a column it does not select:
 * Postgres rejects it, SQLite accepts it and picks an arbitrary row per group. Rejecting it
 * everywhere is the only answer that means the same thing on all four.
 */
export function planDistinct<T>(
  schema: Schema,
  fields: readonly string[],
  query: QueryOptions<T> | undefined,
): GroupTerm[] {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new QueryError('distinct needs at least one field to select distinct values of.');
  }
  const groups = planGroups(schema, fields, 'distinct');

  for (const { field } of query?.orderBy ?? []) {
    if (!groups.some((group) => group.field === field)) {
      throw new QueryError(
        `Cannot order a distinct read by "${String(field)}", which is not one of the fields ` +
          `it selects. Add it to the distinct fields, or drop it from orderBy: a column ` +
          `outside the selected set has more than one value per distinct row.`,
      );
    }
  }
  if (query?.limit !== undefined) assertNonNegativeInteger(query.limit, 'limit');
  if (query?.offset !== undefined) assertNonNegativeInteger(query.offset, 'offset');

  return groups;
}

export interface CompiledDistinct extends CompiledQuery {
  groups: GroupTerm[];
}

export function compileDistinct<T>(
  schema: Schema,
  table: string,
  fields: readonly string[],
  query: QueryOptions<T> | undefined,
  dialect: Dialect,
): CompiledDistinct {
  const groups = planDistinct(schema, fields, query);
  const params = new ParamList(dialect);
  const projection = groups.map((group) => group.column).join(', ');

  const order: OrderTerm[] = (query?.orderBy ?? []).map(({ field, direction }) => {
    if (direction !== 'asc' && direction !== 'desc') {
      throw new QueryError(
        `Invalid sort direction ${JSON.stringify(direction)} on field "${String(field)}". ` +
          `Expected "asc" or "desc".`,
      );
    }
    return {
      expr: (groups.find((group) => group.field === field) as GroupTerm).column,
      direction,
    };
  });

  const sql =
    `SELECT DISTINCT ${projection} FROM ${table}` +
    compileWhere(query?.where, schema, dialect, params) +
    orderByClause(order, dialect) +
    compileLimit(query ?? {}, params, dialect);

  return { sql, params: params.values, groups };
}
