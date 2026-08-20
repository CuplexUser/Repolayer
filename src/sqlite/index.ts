import { DatabaseSync, type StatementSync } from 'node:sqlite';
import path from 'node:path';

import {
  BaseRepo,
  TX_EXECUTOR,
  type BaseRepoOptions,
  type Executor,
  type InternalTxContext,
} from '../core/base.js';
import type { Dialect } from '../core/dialect.js';
import { ConnectionError, UniqueConstraintError } from '../core/errors.js';
import { RepoError } from '../core/errors.js';
import type { IdStrategy, TimestampOptions } from '../core/repo.js';
import type { Schema } from '../core/schema.js';

export interface SqliteConnectionOptions {
  /** Database file, or ':memory:'. */
  file: string;
  /** How long to wait on a locked database before failing. Defaults to 5000ms. */
  busyTimeoutMs?: number;
}

export interface SqliteRepoOptions extends Omit<BaseRepoOptions, 'ids' | 'timestamps'> {
  connection: SqliteConnectionOptions | SqliteConnection;
  ids?: IdStrategy;
  timestamps?: TimestampOptions;
}

/**
 * A `DatabaseSync` plus the identity that lets several repos share one transaction.
 *
 * SQLite allows a single writer, so repos pointed at the same file deliberately share one
 * connection. Opening a second connection to the same file would not just waste a handle,
 * it would make `repo.with(ctx)` impossible between two repos on the same database.
 */
export class SqliteConnection {
  readonly id = Symbol('repolayer.sqlite');
  private readonly statements = new Map<string, StatementSync>();
  private closed = false;

  constructor(
    readonly db: DatabaseSync,
    readonly key: string,
  ) {}

  static open(options: SqliteConnectionOptions): SqliteConnection {
    const key = options.file === ':memory:' ? ':memory:' : path.resolve(options.file);
    const existing = pool.get(key);
    if (existing && !existing.closed) return existing;

    let db: DatabaseSync;
    try {
      db = new DatabaseSync(options.file);
    } catch (error) {
      throw new ConnectionError(`Could not open SQLite database "${options.file}"`, {
        cause: error,
      });
    }

    // WAL lets readers proceed while a writer holds the database, which is what makes a
    // single-writer engine usable for a small web app. It is unavailable in memory.
    if (key !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    // Without this, SQLite's LIKE is case insensitive for ASCII while Postgres LIKE is
    // case sensitive. Turning it on is what lets `like`/`ilike` mean one thing on both.
    db.exec('PRAGMA case_sensitive_like = ON');
    db.exec(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs ?? 5000)}`);

    const connection = new SqliteConnection(db, key);
    pool.set(key, connection);
    return connection;
  }

  /** Prepared statements are cached: the same SQL is re-run constantly. */
  prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  get executor(): Executor {
    const connection = this;
    return {
      async query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
        if (connection.closed) {
          throw new ConnectionError('This SQLite connection is already closed');
        }
        // node:sqlite is synchronous. It is wrapped in the async interface rather than
        // made async, so behavior matches Postgres without pretending there is IO here.
        return connection.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    if (pool.get(this.key) === this) pool.delete(this.key);
    this.db.close();
  }
}

/** One connection per database file, shared by every repo pointed at it. */
const pool = new Map<string, SqliteConnection>();

const UNIQUE_MESSAGE = /UNIQUE constraint failed:\s*(.+)/i;

export class SqliteRepo<T, ID = string> extends BaseRepo<T, ID> {
  override readonly dialect: Dialect = 'sqlite';
  private readonly connection: SqliteConnection;

  constructor(options: SqliteRepoOptions, tx: InternalTxContext | null = null) {
    super(
      {
        table: options.table,
        schema: options.schema,
        ids: options.ids ?? 'uuid',
        timestamps: options.timestamps ?? {},
      },
      tx,
    );
    this.connection =
      options.connection instanceof SqliteConnection
        ? options.connection
        : SqliteConnection.open(options.connection);
  }

  protected override defaultExecutor(): Executor {
    return this.connection.executor;
  }

  protected override connectionId(): symbol {
    return this.connection.id;
  }

  protected override clone(tx: InternalTxContext | null): this {
    const Ctor = this.constructor as new (
      options: SqliteRepoOptions,
      tx: InternalTxContext | null,
    ) => this;
    return new Ctor(
      {
        table: this.table,
        schema: this.schema,
        connection: this.connection,
        ids: this.ids,
        timestamps: this.timestamps,
      },
      tx,
    );
  }

  /**
   * SQLite has exactly one connection, so a transaction runs on it directly. There is
   * nothing to check out and nothing to release, which is the whole difference from
   * Postgres and the reason this hook exists.
   */
  protected override async acquireTxExecutor(): Promise<{
    executor: Executor;
    release: () => void;
  }> {
    return { executor: this.connection.executor, release: () => undefined };
  }

  protected override mapError(error: unknown): unknown {
    if (error instanceof RepoError) return error;
    const message = error instanceof Error ? error.message : String(error);
    const match = UNIQUE_MESSAGE.exec(message);
    if (match) {
      // SQLite reports "table.column, table.column"; report the schema field names.
      const fields = (match[1] as string)
        .split(',')
        .map((part) => part.trim().split('.').pop() ?? '')
        .map((column) => this.schema.fieldsByColumn[column] ?? column)
        .filter(Boolean);
      return new UniqueConstraintError(this.table, fields, { cause: error });
    }
    return error;
  }

  override async close(): Promise<void> {
    this.connection.close();
  }
}

/** Opens (or reuses) a SQLite connection without constructing a repo. */
export function openSqlite(options: SqliteConnectionOptions): SqliteConnection {
  return SqliteConnection.open(options);
}

export function createSqliteRepo<T, ID = string>(options: SqliteRepoOptions): SqliteRepo<T, ID> {
  return new SqliteRepo<T, ID>(options);
}

export type { Schema };
