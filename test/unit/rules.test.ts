import { describe, expect, it } from 'vitest';

import { planAggregate, planDistinct } from '../../src/core/aggregate.js';
import { QueryError } from '../../src/core/errors.js';
import { resolveSortKeys } from '../../src/core/keyset.js';
import {
  compileSelect,
  OPERATORS,
  type Operator,
  type QueryOptions,
} from '../../src/core/query.js';
import { TYPE_RULES } from '../../src/core/rules.js';
import { defineSchema, type FieldType } from '../../src/core/schema.js';
import { createMemoryRepo } from '../../src/testing/memory.js';

/**
 * The type rules are one table, and these tests hold every reader of it to that table: the
 * SQL compiler on every dialect, and `MemoryRepo`, which evaluates filters instead of
 * compiling them and so has to reach the same verdicts by a different road.
 */

/** One field of every type, none of them the key. */
const schema = defineSchema({
  id: { type: 'string', primaryKey: true },
  string: { type: 'string', nullable: true },
  number: { type: 'number', nullable: true },
  integer: { type: 'integer', nullable: true },
  boolean: { type: 'boolean', nullable: true },
  date: { type: 'date', nullable: true },
  json: { type: 'json', nullable: true },
  binary: { type: 'binary', nullable: true },
});

type Row = Record<string, unknown>;

const TYPES = Object.keys(TYPE_RULES) as FieldType[];

/** A value each type accepts, so an allowed operator compiles rather than failing on its value. */
const SAMPLE: Record<FieldType, unknown> = {
  string: 'a',
  number: 1.5,
  integer: 1,
  boolean: true,
  date: new Date(0),
  json: { a: 1 },
  binary: Uint8Array.from([1]),
};

function valueFor(type: FieldType, op: Operator): unknown {
  if (op === 'like' || op === 'ilike') return 'a%';
  if (op === 'in' || op === 'nin') return [SAMPLE[type]];
  if (op === 'isNull') return true;
  return SAMPLE[type];
}

const query = (type: FieldType, op: Operator): QueryOptions<Row> => ({
  where: [{ field: type, op, value: valueFor(type, op) }],
});

describe('TYPE_RULES', () => {
  it('covers every type defineSchema accepts', () => {
    expect(TYPES.sort()).toEqual(
      ['binary', 'boolean', 'date', 'integer', 'json', 'number', 'string'].sort(),
    );
  });

  it('only names operators the compiler knows', () => {
    for (const type of TYPES) {
      for (const op of TYPE_RULES[type].operators) expect(OPERATORS.has(op)).toBe(true);
    }
  });

  it('keeps patterns to strings and ordering off json and binary', () => {
    for (const type of TYPES) {
      expect(TYPE_RULES[type].operators.has('like')).toBe(type === 'string');
      expect(TYPE_RULES[type].orderable).toBe(type !== 'json' && type !== 'binary');
    }
    // An unordered type cannot take a range operator either.
    for (const type of TYPES.filter((t) => !TYPE_RULES[t].orderable)) {
      expect(TYPE_RULES[type].operators.has('gt')).toBe(false);
    }
  });
});

describe('the compiler follows TYPE_RULES', () => {
  for (const dialect of ['sqlite', 'postgres', 'mysql'] as const) {
    it(`accepts exactly the allowed operators per type (${dialect})`, () => {
      for (const type of TYPES) {
        for (const op of OPERATORS as Set<Operator>) {
          const compile = () => compileSelect<Row>(schema, 't', query(type, op), dialect);
          if (TYPE_RULES[type].operators.has(op)) expect(compile, `${type} ${op}`).not.toThrow();
          else expect(compile, `${type} ${op}`).toThrow(QueryError);
        }
      }
    });

    it(`sorts only by orderable types (${dialect})`, () => {
      for (const type of TYPES) {
        const compile = () =>
          compileSelect<Row>(
            schema,
            't',
            { orderBy: [{ field: type, direction: 'asc' }] },
            dialect,
          );
        if (TYPE_RULES[type].orderable) expect(compile, type).not.toThrow();
        else expect(compile, type).toThrow(QueryError);
      }
    });
  }

  it('names the type and what it does support when it refuses', () => {
    expect(() => compileSelect<Row>(schema, 't', query('integer', 'like'), 'postgres')).toThrow(
      /declared integer.*Supported operators for integer: eq, ne, in, nin, isNull, gt/,
    );
  });

  it('holds paging, grouping, and aggregates to the same table', () => {
    for (const type of TYPES) {
      const rules = TYPE_RULES[type];
      const check = (allowed: boolean, run: () => unknown, label: string) => {
        if (allowed) expect(run, `${type} ${label}`).not.toThrow();
        else expect(run, `${type} ${label}`).toThrow(QueryError);
      };

      check(
        rules.orderable,
        () => resolveSortKeys<Row>(schema, [{ field: type, direction: 'asc' }]),
        'page',
      );
      check(rules.groupable, () => planDistinct(schema, [type], undefined), 'distinct');
      check(
        rules.groupable,
        () => planAggregate<Row>(schema, { groupBy: [type], aggregates: { n: { fn: 'count' } } }),
        'groupBy',
      );
      check(
        rules.extremum,
        () => planAggregate<Row>(schema, { aggregates: { m: { fn: 'max', field: type } } }),
        'max',
      );
      check(
        rules.numeric,
        () => planAggregate<Row>(schema, { aggregates: { s: { fn: 'sum', field: type } } }),
        'sum',
      );
    }
  });
});

describe('MemoryRepo follows TYPE_RULES', () => {
  // An empty table on purpose: a refusal has to come from validation, not from a row.
  const repo = createMemoryRepo<Row>({ table: 'rules', schema });

  it('accepts exactly the allowed operators per type', async () => {
    for (const type of TYPES) {
      for (const op of OPERATORS as Set<Operator>) {
        const outcome = await repo.findMany(query(type, op)).then(
          () => 'ok',
          (error: unknown) => error,
        );
        if (TYPE_RULES[type].operators.has(op)) expect(outcome, `${type} ${op}`).toBe('ok');
        else expect(outcome, `${type} ${op}`).toBeInstanceOf(QueryError);
      }
    }
  });

  it('sorts only by orderable types', async () => {
    for (const type of TYPES) {
      const outcome = await repo.findMany({ orderBy: [{ field: type, direction: 'desc' }] }).then(
        () => 'ok',
        (error: unknown) => error,
      );
      if (TYPE_RULES[type].orderable) expect(outcome, type).toBe('ok');
      else expect(outcome, type).toBeInstanceOf(QueryError);
    }
  });
});
