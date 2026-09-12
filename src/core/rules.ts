import { QueryError } from './errors.js';
import type { Operator } from './query.js';
import type { FieldType, Schema } from './schema.js';

/**
 * What each field type may be filtered, sorted, grouped, and aggregated by.
 *
 * One table rather than a check in every place that reads a field, because the SQL compiler,
 * the aggregate planner, keyset paging, and `MemoryRepo` all have to refuse exactly the same
 * things. A query one engine answers and another rejects with a driver error is the drift the
 * conformance suite exists to catch, and a rule that lives in four places drifts.
 *
 * A capability is granted only where every engine gives the same answer. Where they do not,
 * the query is refused up front with a `QueryError` explaining why, instead of being passed
 * through to whichever engine happens to accept it.
 */
export interface TypeRules {
  /** The filter operators a `where` may apply to this type. */
  operators: ReadonlySet<Operator>;
  /** `orderBy`, a `findPage` sort key, and the range operators. */
  orderable: boolean;
  /** `groupBy`, `distinct`, and a distinct `count`. */
  groupable: boolean;
  /** `min` and `max`. */
  extremum: boolean;
  /** `sum` and `avg`. */
  numeric: boolean;
  /** Why this type refuses ordering, grouping, and the range operators, when it does. */
  why?: string;
}

const RANGE: readonly Operator[] = ['gt', 'gte', 'lt', 'lte'];
const EQUALITY: readonly Operator[] = ['eq', 'ne', 'in', 'nin', 'isNull'];
const PATTERN: readonly Operator[] = ['like', 'ilike'];

const COMPARABLE = new Set<Operator>([...EQUALITY, ...RANGE]);

export const TYPE_RULES: Readonly<Record<FieldType, TypeRules>> = {
  string: {
    operators: new Set<Operator>([...EQUALITY, ...RANGE, ...PATTERN]),
    orderable: true,
    groupable: true,
    extremum: true,
    numeric: false,
  },
  number: {
    operators: COMPARABLE,
    orderable: true,
    groupable: true,
    extremum: true,
    numeric: true,
  },
  integer: {
    operators: COMPARABLE,
    orderable: true,
    groupable: true,
    extremum: true,
    numeric: true,
  },
  // Postgres has no `min(boolean)` at all, while SQLite and MySQL store a boolean as 0 or 1
  // and will happily order it. Ordering rows by one is fine everywhere: false sorts first.
  boolean: {
    operators: COMPARABLE,
    orderable: true,
    groupable: true,
    extremum: false,
    numeric: false,
  },
  date: { operators: COMPARABLE, orderable: true, groupable: true, extremum: true, numeric: false },
  // Postgres stores json as `jsonb`, which compares and orders normalized documents, while
  // SQLite and MySQL store the exact text `toDb` produced and compare that. Equality is
  // allowed, with the difference documented; anything that orders or groups is not.
  json: {
    operators: new Set<Operator>(EQUALITY),
    orderable: false,
    groupable: false,
    extremum: false,
    numeric: false,
    why:
      'Postgres normalizes a json value and the other engines store it verbatim, so there is ' +
      'no engine-independent ordering of a json value, and the engines would not agree on ' +
      'which values are the same one.',
  },
  // Every engine compares bytes the same way, but only equality is proven by the
  // conformance suite so far. Widening this needs cases, not just a flag.
  binary: {
    operators: new Set<Operator>(EQUALITY),
    orderable: false,
    groupable: false,
    extremum: false,
    numeric: false,
    why: 'A binary field supports equality and null checks only.',
  },
};

/** Joins the parts of a message, skipping any that are empty. */
function sentences(...parts: (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined && part !== '').join(' ');
}

/**
 * Refuses an operator the field's type does not support.
 *
 * `like` on anything but a string is the case that matters most: SQLite and `MemoryRepo`
 * would match against the value's stored text, while Postgres refuses the comparison with a
 * driver error, so a query that passed every test on one engine would fail on another.
 */
export function assertOperator(schema: Schema, field: string, op: Operator): void {
  const type = schema.types[field] as FieldType;
  const rules = TYPE_RULES[type];
  if (rules.operators.has(op)) return;

  const why =
    op === 'like' || op === 'ilike'
      ? 'Patterns match text, and only a string field is stored as text on every engine.'
      : rules.why;
  throw new QueryError(
    sentences(
      `Operator "${op}" cannot be used on field "${field}", which is declared ${type}.`,
      why,
      `Supported operators for ${type}: ${[...rules.operators].join(', ')}`,
    ),
  );
}

/** Refuses to sort by a field whose type has no order every engine agrees on. */
export function assertOrderable(schema: Schema, field: string, context: string): void {
  const type = schema.types[field] as FieldType;
  const rules = TYPE_RULES[type];
  if (rules.orderable) return;
  throw new QueryError(
    sentences(`Field "${field}" is declared ${type} and cannot be used in ${context}.`, rules.why),
  );
}

/** Refuses to group or deduplicate by a field whose values the engines compare differently. */
export function assertGroupable(schema: Schema, field: string, context: string): void {
  const type = schema.types[field] as FieldType;
  const rules = TYPE_RULES[type];
  if (rules.groupable) return;
  throw new QueryError(
    sentences(`Field "${field}" is declared ${type} and cannot be used in ${context}.`, rules.why),
  );
}
