import type { Dialect } from './dialect.js';
import type { QueryOptions } from './query.js';
import type { Schema } from './schema.js';

/**
 * A handle on an open transaction. Carrying it explicitly is what lets two repos on
 * different tables take part in the same transaction, which the single-repo
 * `withTransaction` callback cannot express on its own.
 */
export interface TxContext {
  readonly dialect: Dialect;
  /** Identifies the owning connection, so binding a foreign repo can be rejected. */
  readonly connectionId: symbol;
  /** Savepoint depth: 0 is the outermost transaction. */
  readonly depth: number;
}

/** How the primary key is produced on `create`. */
export type IdStrategy = 'uuid' | 'autoincrement' | 'provided';

export interface TimestampOptions {
  createdAt?: string | false;
  updatedAt?: string | false;
}

/**
 * The whole contract. Both adapters implement exactly this, and the conformance suite
 * tests exactly this, so a third-party adapter that passes the suite is a drop-in.
 */
export interface Repo<T, ID = string> {
  readonly table: string;
  readonly schema: Schema;
  readonly dialect: Dialect;

  findById(id: ID): Promise<T | null>;
  findOne(query?: QueryOptions<T>): Promise<T | null>;
  findMany(query?: QueryOptions<T>): Promise<T[]>;
  count(query?: QueryOptions<T>): Promise<number>;

  create(data: Partial<T>): Promise<T>;
  createMany(data: Partial<T>[]): Promise<T[]>;
  /** Throws `NotFoundError` when no row has that id. */
  update(id: ID, data: Partial<T>): Promise<T>;
  /** Throws `NotFoundError` when no row has that id. */
  delete(id: ID): Promise<void>;
  /** Deletes every row matching the filter and returns how many were removed. */
  deleteMany(query?: QueryOptions<T>): Promise<number>;

  /**
   * Runs `fn` inside a transaction. Returning commits, throwing rolls back. Nested calls
   * use savepoints rather than failing.
   */
  withTransaction<R>(fn: (repo: Repo<T, ID>, ctx: TxContext) => Promise<R>): Promise<R>;
  /** Returns a view of this repo bound to an already-open transaction. */
  with(ctx: TxContext): Repo<T, ID>;

  /** Dev and test convenience DDL. Not a migration engine. */
  ensureTable(): Promise<void>;
  /** Releases the underlying connection or pool, when this repo owns it. */
  close(): Promise<void>;
}
