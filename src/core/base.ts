import { createTableStatements } from './ddl.js';
import type { Dialect } from './dialect.js';
import { NotFoundError, QueryError, RepoError, SchemaError } from './errors.js';
import { decodeCursor, encodeCursor, keysetFilter, resolveSortKeys } from './keyset.js';
import {
  compileCount,
  compileSelect,
  compileWhere,
  normalizeWhere,
  ParamList,
  selectList,
  type Filter,
  type QueryOptions,
} from './query.js';
import type {
  IdStrategy,
  Page,
  PageOptions,
  Repo,
  StreamOptions,
  TimestampOptions,
  TxContext,
} from './repo.js';
import type { FieldType, Schema } from './schema.js';
import { rowToEntity, toDb } from './serialize.js';

/** What a write reports on an engine that has no `RETURNING`. */
export interface ExecuteResult {
  /** Rows the statement returned, empty for a plain INSERT or UPDATE. */
  rows: Record<string, unknown>[];
  /** Rows the statement matched. Matched, not changed: see the MySQL adapter's FOUND_ROWS. */
  rowCount: number;
  /** First key assigned by an auto-increment INSERT, when the engine reports one. */
  insertId?: number | null;
}

/** The one primitive an adapter must provide: run parameterized SQL, get rows back. */
export interface Executor {
  query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  /**
   * Runs a statement and reports what it affected.
   *
   * Optional, because an engine with `RETURNING` never needs it: the rows come back from
   * the write itself. An engine without it (MySQL, MariaDB) has to be told how many rows a
   * write touched and which key an insert assigned, and this is how. Adding it as an
   * optional member rather than a required one keeps existing third-party adapters
   * compiling untouched.
   */
  execute?(sql: string, params: unknown[]): Promise<ExecuteResult>;
}

/**
 * Internal handle to the executor an open transaction is running on. Exposed on
 * `TxContext` through a symbol so `repo.with(ctx)` can reach it, without inviting
 * application code to reach past the public interface.
 */
export const TX_EXECUTOR = Symbol('repolayer.txExecutor');

export interface InternalTxContext extends TxContext {
  readonly [TX_EXECUTOR]: Executor;
}

export interface BaseRepoOptions {
  table: string;
  schema: Schema;
  ids: IdStrategy;
  timestamps: TimestampOptions;
}

/** Rows pulled per cursor round trip when the caller does not say. */
const DEFAULT_BATCH_SIZE = 100;

/** Rows per page when the caller does not say. */
const DEFAULT_PAGE_SIZE = 50;

/** Savepoint names are generated, never taken from input. */
function savepointName(depth: number): string {
  return `repolayer_sp_${depth}`;
}

/**
 * Everything both adapters do identically: id generation, timestamps, statement building,
 * row mapping, and transaction/savepoint choreography.
 *
 * Adapters supply only the four abstract members below. Keeping the shared logic here
 * rather than duplicating it is the main reason the two adapters cannot quietly drift
 * apart, with the conformance suite as the backstop that proves they have not.
 */
export abstract class BaseRepo<T, ID = string> implements Repo<T, ID> {
  abstract readonly dialect: Dialect;

  readonly table: string;
  readonly schema: Schema;
  protected readonly ids: IdStrategy;
  protected readonly timestamps: TimestampOptions;
  /** The transaction this repo view is bound to, if any. */
  protected readonly tx: InternalTxContext | null;

  constructor(options: BaseRepoOptions, tx: InternalTxContext | null = null) {
    this.table = options.table;
    this.schema = options.schema;
    this.ids = options.ids;
    this.timestamps = options.timestamps;
    this.tx = tx;
    this.validateOptions();
  }

  // ---------------------------------------------------------------- adapter hooks

  /** The executor to use when this repo is not bound to a transaction. */
  protected abstract defaultExecutor(): Executor;

  /** Identifies the underlying connection or pool, so cross-connection binds are caught. */
  protected abstract connectionId(): symbol;

  /** Returns a copy of this repo bound to `tx`. */
  protected abstract clone(tx: InternalTxContext | null): this;

  /**
   * Checks out a dedicated connection for an outermost transaction. SQLite hands back its
   * single connection; Postgres checks a client out of the pool and must release it.
   */
  protected abstract acquireTxExecutor(): Promise<{ executor: Executor; release: () => void }>;

  /** Translates a driver-native error into a `RepoError`, or returns it unchanged. */
  protected abstract mapError(error: unknown): unknown;

  /**
   * Whether writes can name the rows they touched with `RETURNING`.
   *
   * SQLite and Postgres both can, which makes every write one round trip. MySQL and
   * MariaDB cannot, so `create` and `update` become a write plus a keyed read on the same
   * connection, inside a transaction. Declaring it here rather than branching per adapter
   * keeps the statement building in one place, where the two paths cannot drift.
   */
  protected get supportsReturning(): boolean {
    return true;
  }

  /**
   * Opens a cursor over `sql` and yields rows in batches.
   *
   * Written as an async generator by every adapter, because the `finally` block of one is
   * what guarantees the cursor is closed and the connection released when a consumer
   * leaves the loop early. That is the whole reason streaming was not in v1.
   */
  protected abstract openCursor(
    sql: string,
    params: unknown[],
    batchSize: number,
  ): AsyncIterable<Record<string, unknown>[]>;

  abstract close(): Promise<void>;

  // ---------------------------------------------------------------- internals

  protected get exec(): Executor {
    return this.tx ? this.tx[TX_EXECUTOR] : this.defaultExecutor();
  }

  private validateOptions(): void {
    const pkType = this.schema.types[this.schema.primaryKey] as FieldType;
    if (this.ids === 'uuid' && pkType !== 'string') {
      throw new SchemaError(
        `The "uuid" id strategy needs a string primary key, but "${this.schema.primaryKey}" ` +
          `is declared ${pkType}.`,
      );
    }
    if (this.ids === 'autoincrement' && pkType !== 'integer') {
      throw new SchemaError(
        `The "autoincrement" id strategy needs an integer primary key, but ` +
          `"${this.schema.primaryKey}" is declared ${pkType}.`,
      );
    }
    for (const field of [this.timestamps.createdAt, this.timestamps.updatedAt]) {
      if (!field) continue;
      if (this.schema.types[field] === undefined) {
        throw new SchemaError(
          `Timestamp field "${field}" is not in the schema. Add it, or turn timestamps off.`,
        );
      }
      if (this.schema.types[field] !== 'date') {
        throw new SchemaError(
          `Timestamp field "${field}" must be declared type "date", not ` +
            `"${this.schema.types[field]}".`,
        );
      }
    }
  }

  private async run(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    try {
      return await this.exec.query(sql, params);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /** Runs a statement for its effect rather than its rows. Needs `Executor.execute`. */
  private async runExecute(sql: string, params: unknown[]): Promise<ExecuteResult> {
    const executor = this.exec;
    if (executor.execute === undefined) {
      /* c8 ignore next 4 -- an adapter without RETURNING must provide execute() */
      throw new RepoError(
        'This adapter reports no RETURNING support, so its Executor must implement ' +
          'execute(). See the MySQL adapter for the shape.',
      );
    }
    try {
      return await executor.execute(sql, params);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  private toEntity(row: Record<string, unknown>): T {
    return rowToEntity<T>(row, this.schema, this.dialect);
  }

  private bindId(id: unknown, params: ParamList): string {
    const pk = this.schema.primaryKey;
    return params.add(toDb(id, this.schema.types[pk] as FieldType, this.dialect, pk));
  }

  private pkColumn(): string {
    return this.schema.columns[this.schema.primaryKey] as string;
  }

  // ---------------------------------------------------------------- reads

  async findById(id: ID): Promise<T | null> {
    const params = new ParamList(this.dialect);
    const sql =
      `SELECT ${selectList(this.schema)} FROM ${this.table} ` +
      `WHERE ${this.pkColumn()} = ${this.bindId(id, params)} LIMIT ${params.add(1)}`;
    const rows = await this.run(sql, params.values);
    return rows[0] ? this.toEntity(rows[0]) : null;
  }

  async findOne(query?: QueryOptions<T>): Promise<T | null> {
    const rows = await this.findMany({ ...query, limit: 1 });
    return rows[0] ?? null;
  }

  async findMany(query?: QueryOptions<T>): Promise<T[]> {
    const { sql, params } = compileSelect(this.schema, this.table, query, this.dialect);
    const rows = await this.run(sql, params);
    return rows.map((row) => this.toEntity(row));
  }

  async count(query?: QueryOptions<T>): Promise<number> {
    const { sql, params } = compileCount(this.schema, this.table, query, this.dialect);
    const rows = await this.run(sql, params);
    const raw = rows[0]?.['count'];
    // Postgres returns COUNT(*) as a BIGINT, which pg surfaces as a string.
    return typeof raw === 'number' ? raw : Number(raw ?? 0);
  }

  // ---------------------------------------------------------------- cursors

  stream(query?: QueryOptions<T>, opts?: StreamOptions): AsyncIterable<T> {
    // The generator is only started when the caller iterates, so nothing is opened for an
    // iterable that is never consumed, and a compile error surfaces as a rejected `next()`
    // rather than a synchronous throw out of a method that returns an iterable.
    return { [Symbol.asyncIterator]: () => this.streamRows(query, opts) };
  }

  private async *streamRows(
    query: QueryOptions<T> | undefined,
    opts: StreamOptions | undefined,
  ): AsyncGenerator<T> {
    const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
    const signal = opts?.signal;

    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new QueryError(`batchSize must be a positive integer, received ${String(batchSize)}`);
    }
    if (signal?.aborted) throw signal.reason;

    const { sql, params } = compileSelect(this.schema, this.table, query, this.dialect);
    try {
      for await (const batch of this.openCursor(sql, params, batchSize)) {
        // Checked per batch rather than per row: a row is not a place where waiting
        // happens, and the cost of the check would be paid for nothing.
        if (signal?.aborted) throw signal.reason;
        for (const row of batch) yield this.toEntity(row);
      }
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async findPage(query?: QueryOptions<T>, opts?: PageOptions): Promise<Page<T>> {
    const limit = opts?.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new QueryError(`Page limit must be a positive integer, received ${String(limit)}`);
    }
    if (query?.offset !== undefined) {
      throw new QueryError(
        'findPage does not take an offset. Keyset paging replaces offset paging: pass the ' +
          'previous page cursor as `after` instead.',
      );
    }

    const keys = resolveSortKeys<T>(this.schema, query?.orderBy);
    const where: Filter<T>[] = [...normalizeWhere(query?.where)];
    if (opts?.after) {
      where.push(keysetFilter(keys, decodeCursor(this.schema, keys, opts.after)));
    }

    // One row past the page is what tells us whether there is a next page, without a
    // second count query that could disagree with this one.
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

  /**
   * Fills in the id and timestamps in JS rather than leaving them to DB defaults, so both
   * engines produce the same value at the same precision.
   */
  private prepareInsert(data: Partial<T>): Record<string, unknown> {
    const record: Record<string, unknown> = { ...data };
    const pk = this.schema.primaryKey;

    if (this.ids === 'uuid') {
      if (record[pk] === undefined || record[pk] === null) record[pk] = crypto.randomUUID();
    } else if (this.ids === 'autoincrement') {
      // Let the database assign it, even if the caller passed one, so the sequence and
      // the table cannot disagree later.
      delete record[pk];
    } else if (record[pk] === undefined || record[pk] === null) {
      throw new QueryError(`The "provided" id strategy requires an explicit "${pk}" on create.`);
    }

    const now = new Date();
    if (this.timestamps.createdAt) record[this.timestamps.createdAt] = now;
    if (this.timestamps.updatedAt) record[this.timestamps.updatedAt] = now;

    for (const key of Object.keys(record)) {
      if (this.schema.types[key] === undefined) {
        throw new QueryError(
          `Unknown field "${key}" in create. Known fields: ${this.schema.fieldNames.join(', ')}`,
        );
      }
    }
    return record;
  }

  private insertStatement(records: Record<string, unknown>[]): {
    sql: string;
    params: unknown[];
  } {
    const first = records[0] as Record<string, unknown>;
    // One column list for the whole batch keeps a multi-row INSERT valid, so every record
    // must agree on which fields are present.
    const fields = this.schema.fieldNames.filter((f) => first[f] !== undefined);
    const params = new ParamList(this.dialect);

    const tuples = records.map((record, index) => {
      const values = fields.map((field) => {
        if (record[field] === undefined && index > 0) {
          throw new QueryError(
            `createMany requires every record to set the same fields. Record ${index} is ` +
              `missing "${field}", which record 0 sets.`,
          );
        }
        return params.add(
          toDb(record[field], this.schema.types[field] as FieldType, this.dialect, field),
        );
      });
      return `(${values.join(', ')})`;
    });

    const columns = fields.map((f) => this.schema.columns[f]).join(', ');
    // "INSERT INTO t DEFAULT VALUES" is the SQLite and Postgres spelling; MySQL writes an
    // empty column list instead. Same statement, two grammars.
    const empty =
      this.dialect === 'mysql'
        ? `INSERT INTO ${this.table} () VALUES ()`
        : `INSERT INTO ${this.table} DEFAULT VALUES`;
    const sql =
      fields.length === 0
        ? empty
        : `INSERT INTO ${this.table} (${columns}) VALUES ${tuples.join(', ')}`;

    return { sql, params: params.values };
  }

  /** Reads rows back by primary key, in the order the keys were given. */
  private async selectByIds(ids: unknown[]): Promise<T[]> {
    if (ids.length === 0) return [];
    const params = new ParamList(this.dialect);
    const pkType = this.schema.types[this.schema.primaryKey] as FieldType;
    const placeholders = ids
      .map((id) => params.add(toDb(id, pkType, this.dialect, this.schema.primaryKey)))
      .join(', ');
    const sql =
      `SELECT ${selectList(this.schema)} FROM ${this.table} ` +
      `WHERE ${this.pkColumn()} IN (${placeholders})`;

    const rows = await this.run(sql, params.values);
    // IN does not preserve the order of its list, so the rows are put back into insertion
    // order here. Returning a batch in a different order than it was written would be a
    // quiet difference between engines that createMany's own conformance case would catch.
    const byId = new Map(
      rows.map((row) => [String(row[this.pkColumn()]), this.toEntity(row)] as const),
    );
    return ids
      .map((id) => byId.get(String(id)))
      .filter((entity): entity is T => entity !== undefined);
  }

  /**
   * The write-then-read path for engines without `RETURNING`.
   *
   * Both statements must see the same state, so they run on one connection inside a
   * transaction. When the caller already opened one, this joins it rather than nesting a
   * pointless savepoint.
   */
  private async insertAndSelect(
    records: Record<string, unknown>[],
    sql: string,
    params: unknown[],
  ): Promise<T[]> {
    const pk = this.schema.primaryKey;

    const perform = async (repo: BaseRepo<T, ID>): Promise<T[]> => {
      const result = await repo.runExecute(sql, params);

      let ids: unknown[];
      if (this.ids === 'autoincrement') {
        // A single multi-row INSERT is assigned a contiguous block of keys, so the first
        // one plus the row count names every row the statement created.
        const first = result.insertId;
        if (first === undefined || first === null) {
          throw new RepoError(
            `The ${this.dialect} driver did not report an insert id, so the rows just ` +
              `written under the "autoincrement" strategy cannot be read back.`,
          );
        }
        ids = records.map((_, index) => Number(first) + index);
      } else {
        ids = records.map((record) => record[pk]);
      }

      return repo.selectByIds(ids);
    };

    if (this.tx) return perform(this);
    return this.withTransaction(async (scoped) => perform(scoped as BaseRepo<T, ID>));
  }

  async create(data: Partial<T>): Promise<T> {
    const [created] = await this.createMany([data]);
    return created as T;
  }

  async createMany(data: Partial<T>[]): Promise<T[]> {
    if (data.length === 0) return [];
    const records = data.map((item) => this.prepareInsert(item));
    const { sql, params } = this.insertStatement(records);

    if (!this.supportsReturning) return this.insertAndSelect(records, sql, params);

    const rows = await this.run(`${sql} RETURNING ${selectList(this.schema)}`, params);
    return rows.map((row) => this.toEntity(row));
  }

  /**
   * Shared by `update` and `updateMany`: strips the primary key, rejects unknown fields,
   * and applies the `updatedAt` stamp. Keeping it in one place is what stops the two from
   * disagreeing about which fields a write is allowed to touch.
   */
  private prepareUpdate(data: Partial<T>, context: string): Record<string, unknown> {
    const record: Record<string, unknown> = { ...data };
    delete record[this.schema.primaryKey];

    for (const key of Object.keys(record)) {
      if (this.schema.types[key] === undefined) {
        throw new QueryError(
          `Unknown field "${key}" in ${context}. Known fields: ` +
            `${this.schema.fieldNames.join(', ')}`,
        );
      }
    }
    if (this.timestamps.updatedAt) record[this.timestamps.updatedAt] = new Date();
    if (this.timestamps.createdAt) delete record[this.timestamps.createdAt];
    return record;
  }

  /** Renders `SET a = ?, b = ?`, binding each value the way its column stores it. */
  private assignments(record: Record<string, unknown>, params: ParamList): string {
    return Object.keys(record)
      .map(
        (field) =>
          `${this.schema.columns[field]} = ${params.add(
            toDb(record[field], this.schema.types[field] as FieldType, this.dialect, field),
          )}`,
      )
      .join(', ');
  }

  async update(id: ID, data: Partial<T>): Promise<T> {
    const record = this.prepareUpdate(data, 'update');

    const fields = Object.keys(record);
    if (fields.length === 0) {
      // Nothing to change, but the caller still expects the row back, or a NotFoundError.
      const existing = await this.findById(id);
      if (existing === null) throw new NotFoundError(this.table, id);
      return existing;
    }

    const params = new ParamList(this.dialect);
    const sql =
      `UPDATE ${this.table} SET ${this.assignments(record, params)} ` +
      `WHERE ${this.pkColumn()} = ${this.bindId(id, params)}`;

    if (!this.supportsReturning) return this.updateAndSelect(id, sql, params.values);

    const rows = await this.run(`${sql} RETURNING ${selectList(this.schema)}`, params.values);
    if (rows.length === 0) throw new NotFoundError(this.table, id);
    return this.toEntity(rows[0] as Record<string, unknown>);
  }

  /** `update` for engines without `RETURNING`: write, then read the row back. */
  private async updateAndSelect(id: ID, sql: string, params: unknown[]): Promise<T> {
    const perform = async (repo: BaseRepo<T, ID>): Promise<T> => {
      const result = await repo.runExecute(sql, params);
      // Matched rows, not changed rows. An update that sets a column to the value it
      // already holds still found its row, and must not read as a missing one.
      if (result.rowCount === 0) throw new NotFoundError(this.table, id);
      const [row] = await repo.selectByIds([id]);
      if (row === undefined) throw new NotFoundError(this.table, id);
      return row;
    };

    if (this.tx) return perform(this);
    return this.withTransaction(async (scoped) => perform(scoped as BaseRepo<T, ID>));
  }

  /**
   * Applies the same change to every row matching a filter, and reports how many matched.
   *
   * The counterpart of `deleteMany`. It reports rows *matched*, not rows whose values
   * actually changed, so setting a field to the value it already holds still counts: the
   * alternative would make the number depend on the data rather than on the filter.
   */
  async updateMany(query: QueryOptions<T> | undefined, data: Partial<T>): Promise<number> {
    const record = this.prepareUpdate(data, 'updateMany');
    if (Object.keys(record).length === 0) {
      // Nothing to set and no timestamp to stamp, so the only honest answer is how many
      // rows the filter matched.
      return this.count(query);
    }

    const params = new ParamList(this.dialect);
    const sql =
      `UPDATE ${this.table} SET ${this.assignments(record, params)}` +
      compileWhere(query?.where, this.schema, this.dialect, params);

    if (!this.supportsReturning) {
      return (await this.runExecute(sql, params.values)).rowCount;
    }

    const rows = await this.run(`${sql} RETURNING ${this.pkColumn()}`, params.values);
    return rows.length;
  }

  async delete(id: ID): Promise<void> {
    const params = new ParamList(this.dialect);
    const sql = `DELETE FROM ${this.table} WHERE ${this.pkColumn()} = ${this.bindId(id, params)}`;

    if (!this.supportsReturning) {
      const result = await this.runExecute(sql, params.values);
      if (result.rowCount === 0) throw new NotFoundError(this.table, id);
      return;
    }

    const rows = await this.run(`${sql} RETURNING ${this.pkColumn()}`, params.values);
    if (rows.length === 0) throw new NotFoundError(this.table, id);
  }

  /** Deletes rows matching a filter. Returns the number removed. */
  async deleteMany(query?: QueryOptions<T>): Promise<number> {
    const params = new ParamList(this.dialect);
    const sql =
      `DELETE FROM ${this.table}` + compileWhere(query?.where, this.schema, this.dialect, params);

    if (!this.supportsReturning) {
      return (await this.runExecute(sql, params.values)).rowCount;
    }

    const rows = await this.run(`${sql} RETURNING ${this.pkColumn()}`, params.values);
    return rows.length;
  }

  // ---------------------------------------------------------------- transactions

  with(ctx: TxContext): this {
    if (ctx.dialect !== this.dialect) {
      throw new RepoError(`Cannot bind a ${this.dialect} repo to a ${ctx.dialect} transaction.`);
    }
    if (ctx.connectionId !== this.connectionId()) {
      throw new RepoError(
        `Cannot bind "${this.table}" to a transaction on a different connection. Repos can ` +
          `share a transaction only when they share a connection or pool: pass the same ` +
          `connection object (or the same SQLite file) to createRepo for both.`,
      );
    }
    return this.clone(ctx as InternalTxContext);
  }

  async withTransaction<R>(fn: (repo: Repo<T, ID>, ctx: TxContext) => Promise<R>): Promise<R> {
    if (this.tx) return this.runSavepoint(this.tx, fn);

    const { executor, release } = await this.acquireTxExecutor();
    const ctx: InternalTxContext = {
      dialect: this.dialect,
      connectionId: this.connectionId(),
      depth: 0,
      [TX_EXECUTOR]: executor,
    };
    const scoped = this.clone(ctx);

    try {
      await executor.query('BEGIN', []);
    } catch (error) {
      release();
      throw this.mapError(error);
    }

    try {
      const result = await fn(scoped, ctx);
      await executor.query('COMMIT', []);
      return result;
    } catch (error) {
      // A failed rollback must not mask the error that caused it.
      await executor.query('ROLLBACK', []).catch(() => undefined);
      throw this.mapError(error);
    } finally {
      release();
    }
  }

  /** Nested transactions become savepoints rather than an error. */
  private async runSavepoint<R>(
    parent: InternalTxContext,
    fn: (repo: Repo<T, ID>, ctx: TxContext) => Promise<R>,
  ): Promise<R> {
    const executor = parent[TX_EXECUTOR];
    const depth = parent.depth + 1;
    const name = savepointName(depth);
    const ctx: InternalTxContext = {
      dialect: parent.dialect,
      connectionId: parent.connectionId,
      depth,
      [TX_EXECUTOR]: executor,
    };

    await executor.query(`SAVEPOINT ${name}`, []);
    try {
      const result = await fn(this.clone(ctx), ctx);
      await executor.query(`RELEASE SAVEPOINT ${name}`, []);
      return result;
    } catch (error) {
      await executor.query(`ROLLBACK TO SAVEPOINT ${name}`, []).catch(() => undefined);
      await executor.query(`RELEASE SAVEPOINT ${name}`, []).catch(() => undefined);
      throw this.mapError(error);
    }
  }

  // ---------------------------------------------------------------- DDL

  async ensureTable(): Promise<void> {
    for (const statement of createTableStatements(
      this.schema,
      this.table,
      this.dialect,
      this.ids,
    )) {
      await this.run(statement, []);
    }
  }
}
