import { createTableStatements } from './ddl.js';
import type { Dialect } from './dialect.js';
import { NotFoundError, QueryError, RepoError, SchemaError } from './errors.js';
import {
  compileCount,
  compileSelect,
  compileWhere,
  ParamList,
  selectList,
  type QueryOptions,
} from './query.js';
import type { IdStrategy, Repo, TimestampOptions, TxContext } from './repo.js';
import type { FieldType, Schema } from './schema.js';
import { rowToEntity, toDb } from './serialize.js';

/** The one primitive an adapter must provide: run parameterized SQL, get rows back. */
export interface Executor {
  query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
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
      throw new QueryError(
        `The "provided" id strategy requires an explicit "${pk}" on create.`,
      );
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
    const sql =
      fields.length === 0
        ? `INSERT INTO ${this.table} DEFAULT VALUES RETURNING ${selectList(this.schema)}`
        : `INSERT INTO ${this.table} (${columns}) VALUES ${tuples.join(', ')} ` +
          `RETURNING ${selectList(this.schema)}`;

    return { sql, params: params.values };
  }

  async create(data: Partial<T>): Promise<T> {
    const [created] = await this.createMany([data]);
    return created as T;
  }

  async createMany(data: Partial<T>[]): Promise<T[]> {
    if (data.length === 0) return [];
    const records = data.map((item) => this.prepareInsert(item));
    const { sql, params } = this.insertStatement(records);
    const rows = await this.run(sql, params);
    return rows.map((row) => this.toEntity(row));
  }

  async update(id: ID, data: Partial<T>): Promise<T> {
    const record: Record<string, unknown> = { ...data };
    delete record[this.schema.primaryKey];

    for (const key of Object.keys(record)) {
      if (this.schema.types[key] === undefined) {
        throw new QueryError(
          `Unknown field "${key}" in update. Known fields: ${this.schema.fieldNames.join(', ')}`,
        );
      }
    }
    if (this.timestamps.updatedAt) record[this.timestamps.updatedAt] = new Date();
    if (this.timestamps.createdAt) delete record[this.timestamps.createdAt];

    const fields = Object.keys(record);
    if (fields.length === 0) {
      // Nothing to change, but the caller still expects the row back, or a NotFoundError.
      const existing = await this.findById(id);
      if (existing === null) throw new NotFoundError(this.table, id);
      return existing;
    }

    const params = new ParamList(this.dialect);
    const assignments = fields.map(
      (field) =>
        `${this.schema.columns[field]} = ${params.add(
          toDb(record[field], this.schema.types[field] as FieldType, this.dialect, field),
        )}`,
    );
    const sql =
      `UPDATE ${this.table} SET ${assignments.join(', ')} ` +
      `WHERE ${this.pkColumn()} = ${this.bindId(id, params)} ` +
      `RETURNING ${selectList(this.schema)}`;

    const rows = await this.run(sql, params.values);
    if (rows.length === 0) throw new NotFoundError(this.table, id);
    return this.toEntity(rows[0] as Record<string, unknown>);
  }

  async delete(id: ID): Promise<void> {
    const params = new ParamList(this.dialect);
    const sql =
      `DELETE FROM ${this.table} WHERE ${this.pkColumn()} = ${this.bindId(id, params)} ` +
      `RETURNING ${this.pkColumn()}`;
    const rows = await this.run(sql, params.values);
    if (rows.length === 0) throw new NotFoundError(this.table, id);
  }

  /** Deletes rows matching a filter. Returns the number removed. */
  async deleteMany(query?: QueryOptions<T>): Promise<number> {
    const params = new ParamList(this.dialect);
    const sql =
      `DELETE FROM ${this.table}` +
      compileWhere(query?.where, this.schema, this.dialect, params) +
      ` RETURNING ${this.pkColumn()}`;
    const rows = await this.run(sql, params.values);
    return rows.length;
  }

  // ---------------------------------------------------------------- transactions

  with(ctx: TxContext): this {
    if (ctx.dialect !== this.dialect) {
      throw new RepoError(
        `Cannot bind a ${this.dialect} repo to a ${ctx.dialect} transaction.`,
      );
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
