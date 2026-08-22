import { QueryError } from './errors.js';
import type { Filter, OrderBy } from './query.js';
import type { FieldType, Schema } from './schema.js';

/**
 * Keyset ("seek") pagination: the predicate, the cursor token, and the sort normalization
 * that both depend on.
 *
 * The point over `limit`/`offset` is that a page is defined by where it left off rather
 * than by how many rows to skip. Rows inserted or deleted between two requests cannot
 * shift a keyset page, and page 10,000 costs the same as page 1 because the engine seeks
 * on the index instead of counting past everything before it.
 *
 * It is also the fiddliest thing in the package, for three reasons that all show up here:
 * the sort has to be total, mixed sort directions rule out the tidy row-value comparison
 * form, and nullable sort keys need explicit handling that matches the NULLS FIRST/LAST
 * position the ORDER BY already normalizes.
 */

/** Bumped when the token layout changes, so an old token fails loudly rather than paging wrong. */
const TOKEN_VERSION = 1;

interface CursorToken {
  /** Token layout version. */
  v: number;
  /** Fingerprint of the sort spec this token was produced under. */
  s: string;
  /** Encoded sort-key values of the last row on the page. */
  k: unknown[];
}

/**
 * Makes the sort total by appending the primary key.
 *
 * Without a unique final key, two rows that tie on every sort key have no defined order
 * between them, and a page boundary landing inside that tie will skip one row and repeat
 * another. That is the classic keyset bug, and it only shows up once there is enough data
 * for ties to straddle a boundary.
 */
export function resolveSortKeys<T>(
  schema: Schema,
  orderBy: OrderBy<T>[] | undefined,
): OrderBy<T>[] {
  const pk = schema.primaryKey as keyof T & string;
  const keys = [...(orderBy ?? [])];

  for (const key of keys) {
    if (schema.columns[key.field] === undefined) {
      throw new QueryError(
        `Unknown field "${String(key.field)}" in orderBy. Known fields: ` +
          `${schema.fieldNames.join(', ')}`,
      );
    }
    if (schema.types[key.field] === 'json') {
      throw new QueryError(
        `Cannot page by "${String(key.field)}": a json field has no total order, so a ` +
          `cursor built from it could not be compared reliably.`,
      );
    }
  }

  if (!keys.some((key) => key.field === pk)) keys.push({ field: pk, direction: 'asc' });
  return keys;
}

function fingerprint<T>(keys: OrderBy<T>[]): string {
  // FNV-1a. Not a security boundary: this only has to notice that a token was minted under
  // a different sort than the one it is being used with, which a 32 bit hash does fine.
  let hash = 0x811c9dc5;
  for (const key of keys) {
    for (const char of `${String(key.field)}:${key.direction};`) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, '0');
}

function encodeValue(value: unknown, type: FieldType, field: string): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'date':
      if (!(value instanceof Date)) {
        throw new QueryError(`Sort key "${field}" is declared date but held a non-Date value`);
      }
      return value.toISOString();
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
      return value;
    case 'json':
      /* c8 ignore next 2 -- resolveSortKeys rejects json keys before this is reachable */
      throw new QueryError(`Cannot page by json field "${field}"`);
  }
}

function decodeValue(value: unknown, type: FieldType, field: string): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'date': {
      const date = new Date(value as string);
      if (Number.isNaN(date.getTime())) {
        throw new QueryError(`Cursor holds an invalid date for sort key "${field}"`);
      }
      return date;
    }
    case 'number':
    case 'integer':
      if (typeof value !== 'number') {
        throw new QueryError(`Cursor holds a non-numeric value for sort key "${field}"`);
      }
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new QueryError(`Cursor holds a non-boolean value for sort key "${field}"`);
      }
      return value;
    case 'string':
      if (typeof value !== 'string') {
        throw new QueryError(`Cursor holds a non-string value for sort key "${field}"`);
      }
      return value;
    case 'json':
      /* c8 ignore next 2 -- resolveSortKeys rejects json keys before this is reachable */
      throw new QueryError(`Cannot page by json field "${field}"`);
  }
}

/** Builds the opaque token that identifies the last row of a page. */
export function encodeCursor<T>(schema: Schema, keys: OrderBy<T>[], row: T): string {
  const token: CursorToken = {
    v: TOKEN_VERSION,
    s: fingerprint(keys),
    k: keys.map((key) =>
      encodeValue(
        (row as Record<string, unknown>)[key.field],
        schema.types[key.field] as FieldType,
        String(key.field),
      ),
    ),
  };
  return Buffer.from(JSON.stringify(token), 'utf8').toString('base64url');
}

/**
 * Reads a token back, refusing anything that does not match the sort it is used with.
 *
 * A token that silently pages under the wrong sort produces a result set with gaps and
 * repeats and no error at all, which is far worse than a rejected request.
 */
export function decodeCursor<T>(schema: Schema, keys: OrderBy<T>[], cursor: string): unknown[] {
  let token: CursorToken;
  try {
    token = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorToken;
  } catch (error) {
    throw new QueryError('Page cursor is not a valid token', { cause: error });
  }

  if (token === null || typeof token !== 'object' || !Array.isArray(token.k)) {
    throw new QueryError('Page cursor is not a valid token');
  }
  if (token.v !== TOKEN_VERSION) {
    throw new QueryError(
      `Page cursor was minted by a different version of repolayer (token v${String(token.v)}, ` +
        `this build expects v${TOKEN_VERSION}). Restart paging from the first page.`,
    );
  }
  if (token.s !== fingerprint(keys)) {
    throw new QueryError(
      'Page cursor was minted under a different sort order. A cursor is only meaningful ' +
        'for the exact orderBy that produced it, so paging must restart from the first page.',
    );
  }
  if (token.k.length !== keys.length) {
    throw new QueryError('Page cursor does not match the number of sort keys');
  }

  return keys.map((key, index) =>
    decodeValue(token.k[index], schema.types[key.field] as FieldType, String(key.field)),
  );
}

/**
 * Sentinel for "no row can be after this one". Compared by identity, so it must be a single
 * shared object rather than a fresh empty group each time.
 */
const NEVER: Filter<never> = { or: [] };

/**
 * The predicate for "strictly after this row in this sort order".
 *
 * Written as a lexicographic OR expansion rather than the tidier row-value comparison
 * `(a, b) > ($1, $2)`, because row-value comparison is only correct when every key sorts in
 * the same direction and no key is nullable. This package allows both.
 *
 * Null handling reproduces the position `compileOrderBy` already normalizes, ASC putting
 * nulls last and DESC putting them first:
 *
 *   direction  last value  strictly after      equal
 *   ---------  ----------  ------------------  ---------
 *   asc        non-null    k > v OR k IS NULL  k = v
 *   asc        null        nothing             k IS NULL
 *   desc       non-null    k < v               k = v
 *   desc       null        k IS NOT NULL       k IS NULL
 */
export function keysetFilter<T>(keys: OrderBy<T>[], values: unknown[]): Filter<T> {
  const branches: Filter<T>[] = [];

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i] as OrderBy<T>;
    const after = strictlyAfter(key, values[i]);
    // An ASC key whose last value was null has nothing after it, so the branch would be a
    // constant false. Dropping it keeps the generated SQL to what actually matters.
    if ((after as Filter<never>) === NEVER) continue;

    const conditions: Filter<T>[] = [];
    for (let j = 0; j < i; j += 1) {
      conditions.push(equalTo(keys[j] as OrderBy<T>, values[j]));
    }
    conditions.push(after);
    branches.push(conditions.length === 1 ? (conditions[0] as Filter<T>) : { and: conditions });
  }

  return { or: branches };
}

function strictlyAfter<T>(key: OrderBy<T>, value: unknown): Filter<T> {
  if (key.direction === 'asc') {
    if (value === null) return NEVER as Filter<T>;
    return {
      or: [
        { field: key.field, op: 'gt', value },
        { field: key.field, op: 'isNull' },
      ],
    };
  }
  if (value === null) return { field: key.field, op: 'isNull', value: false };
  return { field: key.field, op: 'lt', value };
}

function equalTo<T>(key: OrderBy<T>, value: unknown): Filter<T> {
  return value === null
    ? { field: key.field, op: 'isNull' }
    : { field: key.field, op: 'eq', value };
}
