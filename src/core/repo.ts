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

/** Options for `repo.stream()`. */
export interface StreamOptions {
  /**
   * How many rows to pull from the engine per round trip. Larger trades memory for fewer
   * round trips; it never changes which rows are returned or in what order. Defaults to 100.
   */
  batchSize?: number;
  /** Cancels the stream from outside the loop. The signal's reason is what gets thrown. */
  signal?: AbortSignal;
}

/** Options for `repo.findPage()`. */
export interface PageOptions {
  /** Rows per page. Defaults to 50. */
  limit?: number;
  /** The `cursor` from the previous page. Omit or pass null for the first page. */
  after?: string | null;
}

/** One page of a keyset-paged result. */
export interface Page<T> {
  items: T[];
  /** Token for the next page, or null when this page is the last one. */
  cursor: string | null;
  hasMore: boolean;
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

  /**
   * Pulls rows in batches instead of materializing the whole result set, so a table larger
   * than memory can be exported, migrated, or re-indexed.
   *
   * The cursor holds a resource for as long as the loop runs: an open transaction on
   * Postgres, a read lock on SQLite. Leaving the loop early, by `break`, `return`, or a
   * throw, closes it. Not consuming the iterator at all never opens it in the first place.
   */
  stream(query?: QueryOptions<T>, opts?: StreamOptions): AsyncIterable<T>;

  /**
   * Keyset pagination. Unlike `stream`, this holds nothing between calls: the returned
   * cursor is an opaque token, so the next page can be fetched by a different process
   * minutes later.
   *
   * Paging stays correct as rows are inserted underneath it, which `limit`/`offset` cannot
   * promise, and stays fast at any depth, which `offset` also cannot.
   */
  findPage(query?: QueryOptions<T>, opts?: PageOptions): Promise<Page<T>>;

  create(data: Partial<T>): Promise<T>;
  createMany(data: Partial<T>[]): Promise<T[]>;
  /** Throws `NotFoundError` when no row has that id. */
  update(id: ID, data: Partial<T>): Promise<T>;
  /**
   * Applies one change to every row matching the filter and returns how many matched.
   * The counterpart of `deleteMany`.
   */
  updateMany(query: QueryOptions<T> | undefined, data: Partial<T>): Promise<number>;
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
