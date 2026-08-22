import { NotFoundError, QueryError, RepoError, UniqueConstraintError } from '../core/errors.js';
import { decodeCursor, encodeCursor, keysetFilter, resolveSortKeys } from '../core/keyset.js';
import {
  assertNonNegativeInteger,
  normalizeWhere,
  OPERATORS,
  type FieldFilter,
  type Filter,
  type OrderBy,
  type QueryOptions,
} from '../core/query.js';
import type {
  IdStrategy,
  Page,
  PageOptions,
  Repo,
  StreamOptions,
  TimestampOptions,
  TxContext,
} from '../core/repo.js';
import type { FieldDef, FieldMap, FieldType, Schema } from '../core/schema.js';
import { fromDb, toDb } from '../core/serialize.js';

/**
 * A `Repo<T>` with no database at all, for unit tests that should not need one.
 *
 * It passes the same conformance suite as the SQLite and Postgres adapters, which is the
 * only reason it is trustworthy: an in-memory fake that quietly behaves differently from
 * the real thing is worse than no fake, because the tests it passes stop meaning anything.
 *
 * It is also the strongest evidence available that `QueryOptions` is not a SQL builder in
 * disguise. Nothing here compiles a string: filters are evaluated, ordering is a
 * comparator, and paging reuses the very same keyset predicate the SQL adapters compile,
 * just interpreted instead.
 *
 * What it deliberately does not model: SQL isolation levels, concurrent writers, and
 * anything about how a real engine schedules work. Use it to test application logic, not
 * to test your database.
 */

/** One stored row, holding values in their `toDb` form, keyed by field name. */
type StoredRow = Record<string, unknown>;

/** Table name to rows, keyed by the string form of the primary key. */
type Tables = Map<string, Map<string, StoredRow>>;

function cloneValue(value: unknown): unknown {
  return value instanceof Date ? new Date(value.getTime()) : value;
}

function cloneRow(row: StoredRow): StoredRow {
  const copy: StoredRow = {};
  for (const key of Object.keys(row)) copy[key] = cloneValue(row[key]);
  return copy;
}

function cloneTables(tables: Tables): Tables {
  const copy: Tables = new Map();
  for (const [table, rows] of tables) {
    const rowCopy = new Map<string, StoredRow>();
    for (const [id, row] of rows) rowCopy.set(id, cloneRow(row));
    copy.set(table, rowCopy);
  }
  return copy;
}

/**
 * The shared state several repos sit on, and the thing a transaction snapshots.
 *
 * It is the memory equivalent of a connection: two repos can only share a transaction when
 * they share a store, exactly as two SQL repos must share a connection or pool.
 */
export class MemoryStore {
  readonly id = Symbol('repolayer.memory');
  private tables: Tables = new Map();
  /** One snapshot per open transaction or savepoint, innermost last. */
  private readonly snapshots: Tables[] = [];
  private readonly sequences = new Map<string, number>();

  rows(table: string): Map<string, StoredRow> {
    let rows = this.tables.get(table);
    if (rows === undefined) {
      rows = new Map();
      this.tables.set(table, rows);
    }
    return rows;
  }

  nextId(table: string): number {
    const next = (this.sequences.get(table) ?? 0) + 1;
    this.sequences.set(table, next);
    return next;
  }

  /** Depth of the transaction this opens: 0 is the outermost. */
  begin(): number {
    this.snapshots.push(cloneTables(this.tables));
    return this.snapshots.length - 1;
  }

  commit(): void {
    // Keeping the current state and discarding the snapshot is what committing means here.
    this.snapshots.pop();
  }

  rollback(): void {
    const snapshot = this.snapshots.pop();
    if (snapshot !== undefined) this.tables = snapshot;
  }

  get depth(): number {
    return this.snapshots.length;
  }

  /** Drops everything. Handy between tests that share one store. */
  clear(): void {
    this.tables = new Map();
    this.snapshots.length = 0;
    this.sequences.clear();
  }
}

export interface MemoryRepoOptions {
  table: string;
  schema: Schema;
  /** Share one store between repos so they can share a transaction. */
  store?: MemoryStore;
  ids?: IdStrategy;
  timestamps?: TimestampOptions;
}

/** Turns a SQL LIKE pattern into an anchored regular expression. */
function likeToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  let source = '^';
  for (const char of pattern) {
    if (char === '%') source += '[\\s\\S]*';
    else if (char === '_') source += '[\\s\\S]';
    // Everything else is escaped. Without this a filter value would be executable, which
    // is the injection problem wearing a different costume.
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${source}$`, caseInsensitive ? 'i' : '');
}

/** Orders two non-null stored values of the same declared type. */
function compareValues(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return (a ? 1 : 0) - (b ? 1 : 0);
  }
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Renders a stored value as text, the way a SQL LIKE coerces a non-text column. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === b;
  return compareValues(a, b) === 0;
}

export class MemoryRepo<T, ID = string> implements Repo<T, ID> {
  readonly dialect = 'memory' as const;
  readonly table: string;
  readonly schema: Schema;
  readonly store: MemoryStore;

  private readonly ids: IdStrategy;
  private readonly timestamps: TimestampOptions;

  constructor(options: MemoryRepoOptions) {
    this.table = options.table;
    this.schema = options.schema;
    this.store = options.store ?? new MemoryStore();
    this.ids = options.ids ?? 'uuid';
    this.timestamps = options.timestamps ?? {};
    this.validateOptions();
  }

  private validateOptions(): void {
    const pkType = this.schema.types[this.schema.primaryKey];
    if (this.ids === 'uuid' && pkType !== 'string') {
      throw new RepoError(
        `The "uuid" id strategy needs a string primary key, but ` +
          `"${this.schema.primaryKey}" is declared ${String(pkType)}.`,
      );
    }
    if (this.ids === 'autoincrement' && pkType !== 'integer') {
      throw new RepoError(
        `The "autoincrement" id strategy needs an integer primary key, but ` +
          `"${this.schema.primaryKey}" is declared ${String(pkType)}.`,
      );
    }
  }

  // ---------------------------------------------------------------- internals

  private get rows(): Map<string, StoredRow> {
    return this.store.rows(this.table);
  }

  private key(id: unknown): string {
    return String(id);
  }

  private toEntity(row: StoredRow): T {
    const entity: Record<string, unknown> = {};
    for (const field of this.schema.fieldNames) {
      entity[field] = fromDb(
        cloneValue(row[field] ?? null),
        this.schema.types[field] as FieldType,
        'memory',
        field,
      );
    }
    return entity as T;
  }

  /** Validates a value against its declared type and stores it the way `toDb` would. */
  private store1(value: unknown, field: string): unknown {
    return toDb(value, this.schema.types[field] as FieldType, 'memory', field);
  }

  private assertKnownFields(record: Record<string, unknown>, context: string): void {
    for (const key of Object.keys(record)) {
      if (this.schema.types[key] === undefined) {
        throw new QueryError(
          `Unknown field "${key}" in ${context}. Known fields: ` +
            `${this.schema.fieldNames.join(', ')}`,
        );
      }
    }
  }

  /** Every field the schema marks unique, plus the primary key. */
  private uniqueFields(): string[] {
    const fields = this.schema.fields as FieldMap;
    return this.schema.fieldNames.filter(
      (name) => name === this.schema.primaryKey || (fields[name] as FieldDef).unique === true,
    );
  }

  private assertUnique(candidate: StoredRow, exceptKey: string | null): void {
    for (const field of this.uniqueFields()) {
      const value = candidate[field];
      if (value === undefined || value === null) continue;
      for (const [key, row] of this.rows) {
        if (key === exceptKey) continue;
        if (valuesEqual(row[field], value)) {
          throw new UniqueConstraintError(this.table, [field]);
        }
      }
    }
  }

  // ---------------------------------------------------------------- filtering

  /**
   * Checks the whole filter tree before a single row is examined.
   *
   * A SQL adapter gets this for free: the query is compiled once, so a bad field or
   * operator fails before anything reaches the database. Evaluating per row would mean an
   * empty table silently accepts a malformed filter, which is a difference in behavior
   * between engines rather than a difference in implementation, and the conformance suite
   * is right to fail it.
   */
  private validateFilter(node: Filter<T>, depth: number): void {
    if (depth > 16) {
      throw new QueryError(
        'Filter tree is nested deeper than 16 levels. Flatten it, or filter in ' +
          'application code: an unbounded tree compiles to unbounded SQL.',
      );
    }
    const and = (node as { and?: Filter<T>[] }).and;
    if (Array.isArray(and)) {
      for (const child of and) this.validateFilter(child, depth + 1);
      return;
    }
    const or = (node as { or?: Filter<T>[] }).or;
    if (Array.isArray(or)) {
      for (const child of or) this.validateFilter(child, depth + 1);
      return;
    }

    const filter = node as FieldFilter<T>;
    const field = String(filter.field);
    const { op } = filter;

    if (typeof op !== 'string' || !OPERATORS.has(op)) {
      throw new QueryError(
        `Unknown operator ${JSON.stringify(op)} on field "${field}". ` +
          `Supported operators: ${[...OPERATORS].join(', ')}`,
      );
    }
    if (this.schema.types[field] === undefined) {
      throw new QueryError(
        `Unknown field "${field}" in where. Known fields: ${this.schema.fieldNames.join(', ')}`,
      );
    }
    if ((op === 'in' || op === 'nin') && !Array.isArray(filter.value)) {
      throw new QueryError(
        `Operator "${op}" on field "${field}" requires an array value, received ` +
          `${filter.value === undefined ? 'undefined' : typeof filter.value}`,
      );
    }
    if ((op === 'like' || op === 'ilike') && typeof filter.value !== 'string') {
      throw new QueryError(`Operator "${op}" on field "${field}" requires a string pattern`);
    }
  }

  private matches(row: StoredRow, node: Filter<T>): boolean {
    const and = (node as { and?: Filter<T>[] }).and;
    if (Array.isArray(and)) return and.every((child) => this.matches(row, child));
    const or = (node as { or?: Filter<T>[] }).or;
    if (Array.isArray(or)) return or.some((child) => this.matches(row, child));
    return this.matchesField(row, node as FieldFilter<T>);
  }

  /** Evaluates one already-validated field filter against one row. */
  private matchesField(row: StoredRow, filter: FieldFilter<T>): boolean {
    const field = String(filter.field);
    const op = filter.op;
    const actual = row[field] ?? null;
    const bind = (value: unknown): unknown => this.store1(value, field);

    switch (op) {
      case 'eq':
        // `eq: null` means IS NULL, matching the compiler: `= NULL` is never true in SQL,
        // and silently matching nothing would be a trap rather than a feature.
        if (filter.value === null || filter.value === undefined) return actual === null;
        return actual !== null && valuesEqual(actual, bind(filter.value));

      case 'ne':
        if (filter.value === null || filter.value === undefined) return actual !== null;
        // Nulls are kept, which raw SQL would drop.
        return actual === null || !valuesEqual(actual, bind(filter.value));

      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        if (actual === null) return false;
        const order = compareValues(actual, bind(filter.value));
        if (op === 'gt') return order > 0;
        if (op === 'gte') return order >= 0;
        if (op === 'lt') return order < 0;
        return order <= 0;
      }

      case 'in':
      case 'nin': {
        const bound = (filter.value as unknown[]).map(bind);
        const present = actual !== null && bound.some((value) => valuesEqual(actual, value));
        // An empty `in` matches nothing and an empty `nin` matches everything, and `nin`
        // keeps nulls, exactly as the compiled SQL does.
        return op === 'in' ? present : actual === null || !present;
      }

      case 'like':
      case 'ilike': {
        if (actual === null) return false;
        return likeToRegExp(filter.value as string, op === 'ilike').test(asText(actual));
      }

      case 'isNull': {
        const wantNull = filter.value === undefined ? true : Boolean(filter.value);
        return wantNull ? actual === null : actual !== null;
      }
    }

    /* c8 ignore next 2 -- unreachable: the operator was validated above */
    throw new QueryError(`Unhandled operator ${JSON.stringify(op)}`);
  }

  /**
   * Sorts the way `compileOrderBy` does, with the null position stated explicitly: last on
   * ASC and first on DESC, on every engine.
   */
  private sort(rows: StoredRow[], orderBy: OrderBy<T>[] | undefined): StoredRow[] {
    if (orderBy === undefined || orderBy.length === 0) return rows;

    for (const { field, direction } of orderBy) {
      if (direction !== 'asc' && direction !== 'desc') {
        throw new QueryError(
          `Invalid sort direction ${JSON.stringify(direction)} on field "${String(field)}". ` +
            `Expected "asc" or "desc".`,
        );
      }
      if (this.schema.types[field] === undefined) {
        throw new QueryError(
          `Unknown field "${String(field)}" in orderBy. Known fields: ` +
            `${this.schema.fieldNames.join(', ')}`,
        );
      }
    }

    return [...rows].sort((left, right) => {
      for (const { field, direction } of orderBy) {
        const a = left[field] ?? null;
        const b = right[field] ?? null;
        if (a === null && b === null) continue;
        if (a === null) return direction === 'asc' ? 1 : -1;
        if (b === null) return direction === 'asc' ? -1 : 1;
        const order = compareValues(a, b);
        if (order !== 0) return direction === 'asc' ? order : -order;
      }
      return 0;
    });
  }

  private select(query?: QueryOptions<T>): StoredRow[] {
    const filters = normalizeWhere(query?.where);
    // Validated first, so a malformed filter fails on an empty table too.
    for (const filter of filters) this.validateFilter(filter, 0);

    let rows = [...this.rows.values()].filter((row) =>
      filters.every((filter) => this.matches(row, filter)),
    );
    rows = this.sort(rows, query?.orderBy);

    if (query?.limit !== undefined) assertNonNegativeInteger(query.limit, 'limit');
    if (query?.offset !== undefined) assertNonNegativeInteger(query.offset, 'offset');

    const start = query?.offset ?? 0;
    const end = query?.limit === undefined ? undefined : start + query.limit;
    return rows.slice(start, end);
  }

  // ---------------------------------------------------------------- reads

  async findById(id: ID): Promise<T | null> {
    const row = this.rows.get(this.key(id));
    return Promise.resolve(row === undefined ? null : this.toEntity(row));
  }

  async findOne(query?: QueryOptions<T>): Promise<T | null> {
    const rows = await this.findMany({ ...query, limit: 1 });
    return rows[0] ?? null;
  }

  async findMany(query?: QueryOptions<T>): Promise<T[]> {
    return Promise.resolve(this.select(query).map((row) => this.toEntity(row)));
  }

  async count(query?: QueryOptions<T>): Promise<number> {
    return Promise.resolve(this.select(query).length);
  }

  stream(query?: QueryOptions<T>, opts?: StreamOptions): AsyncIterable<T> {
    return { [Symbol.asyncIterator]: () => this.streamRows(query, opts) };
  }

  private async *streamRows(
    query: QueryOptions<T> | undefined,
    opts: StreamOptions | undefined,
  ): AsyncGenerator<T> {
    const batchSize = opts?.batchSize ?? 100;
    const signal = opts?.signal;

    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new QueryError(`batchSize must be a positive integer, received ${String(batchSize)}`);
    }
    if (signal?.aborted) throw signal.reason;

    // Snapshotted up front, the way a cursor sees a stable result set rather than whatever
    // the table happens to hold at each step.
    const rows = this.select(query);
    for (let i = 0; i < rows.length; i += batchSize) {
      if (signal?.aborted) throw signal.reason;
      for (const row of rows.slice(i, i + batchSize)) yield this.toEntity(row);
    }
  }

  async findPage(query?: QueryOptions<T>, opts?: PageOptions): Promise<Page<T>> {
    const limit = opts?.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new QueryError(`Page limit must be a positive integer, received ${String(limit)}`);
    }
    if (query?.offset !== undefined) {
      throw new QueryError(
        'findPage does not take an offset. Keyset paging replaces offset paging: pass the ' +
          'previous page cursor as `after` instead.',
      );
    }

    // The same keyset predicate the SQL adapters compile, interpreted rather than
    // compiled. That it needs no special case here is the point.
    const keys = resolveSortKeys<T>(this.schema, query?.orderBy);
    const where: Filter<T>[] = [...normalizeWhere(query?.where)];
    if (opts?.after) {
      where.push(keysetFilter(keys, decodeCursor(this.schema, keys, opts.after)));
    }

    const rows = await this.findMany({ ...query, where, orderBy: keys, limit: limit + 1 });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];

    return {
      items,
      cursor: hasMore && last !== undefined ? encodeCursor(this.schema, keys, last) : null,
      hasMore,
    };
  }

  // ---------------------------------------------------------------- writes

  private prepareInsert(data: Partial<T>): StoredRow {
    const input: Record<string, unknown> = { ...data };
    const pk = this.schema.primaryKey;

    if (this.ids === 'uuid') {
      if (input[pk] === undefined || input[pk] === null) input[pk] = crypto.randomUUID();
    } else if (this.ids === 'autoincrement') {
      delete input[pk];
    } else if (input[pk] === undefined || input[pk] === null) {
      throw new QueryError(`The "provided" id strategy requires an explicit "${pk}" on create.`);
    }

    const now = new Date();
    if (this.timestamps.createdAt) input[this.timestamps.createdAt] = now;
    if (this.timestamps.updatedAt) input[this.timestamps.updatedAt] = now;

    this.assertKnownFields(input, 'create');

    const record: StoredRow = {};
    for (const field of this.schema.fieldNames) {
      if (field === pk && this.ids === 'autoincrement') {
        record[field] = this.store.nextId(this.table);
        continue;
      }
      record[field] = this.store1(input[field] ?? null, field);
    }
    return record;
  }

  async create(data: Partial<T>): Promise<T> {
    const [created] = await this.createMany([data]);
    return created as T;
  }

  async createMany(data: Partial<T>[]): Promise<T[]> {
    if (data.length === 0) return [];
    const records = data.map((item) => this.prepareInsert(item));

    // Prepared in full before anything is stored, so a rejected record in the middle of a
    // batch cannot leave the earlier ones behind.
    for (const record of records) this.assertUnique(record, null);
    for (let i = 0; i < records.length; i += 1) {
      for (let j = i + 1; j < records.length; j += 1) {
        for (const field of this.uniqueFields()) {
          const a = (records[i] as StoredRow)[field];
          if (a !== null && a !== undefined && valuesEqual(a, (records[j] as StoredRow)[field])) {
            throw new UniqueConstraintError(this.table, [field]);
          }
        }
      }
    }

    for (const record of records) {
      this.rows.set(this.key(record[this.schema.primaryKey]), record);
    }
    return Promise.resolve(records.map((record) => this.toEntity(record)));
  }

  private prepareUpdate(data: Partial<T>, context: string): Record<string, unknown> {
    const record: Record<string, unknown> = { ...data };
    delete record[this.schema.primaryKey];
    this.assertKnownFields(record, context);
    if (this.timestamps.updatedAt) record[this.timestamps.updatedAt] = new Date();
    if (this.timestamps.createdAt) delete record[this.timestamps.createdAt];
    return record;
  }

  private applyUpdate(key: string, row: StoredRow, changes: Record<string, unknown>): StoredRow {
    const updated = cloneRow(row);
    for (const field of Object.keys(changes)) {
      updated[field] = this.store1(changes[field], field);
    }
    this.assertUnique(updated, key);
    this.rows.set(key, updated);
    return updated;
  }

  async update(id: ID, data: Partial<T>): Promise<T> {
    const key = this.key(id);
    const existing = this.rows.get(key);
    if (existing === undefined) throw new NotFoundError(this.table, id);

    const changes = this.prepareUpdate(data, 'update');
    if (Object.keys(changes).length === 0) return this.toEntity(existing);
    return Promise.resolve(this.toEntity(this.applyUpdate(key, existing, changes)));
  }

  async updateMany(query: QueryOptions<T> | undefined, data: Partial<T>): Promise<number> {
    const changes = this.prepareUpdate(data, 'updateMany');
    const matched = this.select(query);
    if (Object.keys(changes).length === 0) return Promise.resolve(matched.length);

    for (const row of matched) {
      this.applyUpdate(this.key(row[this.schema.primaryKey]), row, changes);
    }
    return Promise.resolve(matched.length);
  }

  async delete(id: ID): Promise<void> {
    const key = this.key(id);
    if (!this.rows.delete(key)) throw new NotFoundError(this.table, id);
    return Promise.resolve();
  }

  async deleteMany(query?: QueryOptions<T>): Promise<number> {
    const matched = this.select(query);
    for (const row of matched) this.rows.delete(this.key(row[this.schema.primaryKey]));
    return Promise.resolve(matched.length);
  }

  // ---------------------------------------------------------------- transactions

  with(ctx: TxContext): this {
    if (ctx.dialect !== this.dialect) {
      throw new RepoError(`Cannot bind a ${this.dialect} repo to a ${ctx.dialect} transaction.`);
    }
    if (ctx.connectionId !== this.store.id) {
      throw new RepoError(
        `Cannot bind "${this.table}" to a transaction on a different store. Repos can share ` +
          `a transaction only when they share a MemoryStore: pass the same store to both.`,
      );
    }
    // The store *is* the transaction, so a bound view is this repo. Nothing is copied,
    // which is exactly why two repos on one store roll back together.
    return this;
  }

  async withTransaction<R>(fn: (repo: Repo<T, ID>, ctx: TxContext) => Promise<R>): Promise<R> {
    const depth = this.store.begin();
    const ctx: TxContext = {
      dialect: this.dialect,
      connectionId: this.store.id,
      depth,
    };

    try {
      const result = await fn(this, ctx);
      this.store.commit();
      return result;
    } catch (error) {
      // Restores the snapshot taken at this depth, which is a savepoint rollback when this
      // is a nested call and a full rollback when it is not.
      this.store.rollback();
      throw error;
    }
  }

  // ---------------------------------------------------------------- lifecycle

  /** There is no DDL to run, but the table is created so a fresh repo reads as empty. */
  async ensureTable(): Promise<void> {
    this.store.rows(this.table);
    return Promise.resolve();
  }

  /** Nothing to release. Present because the contract has it. */
  async close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Builds a repo over a fresh store, or over one shared with other repos. */
export function createMemoryRepo<T, ID = string>(options: MemoryRepoOptions): MemoryRepo<T, ID> {
  return new MemoryRepo<T, ID>(options);
}
