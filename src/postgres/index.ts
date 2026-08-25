import {
  BaseRepo,
  type BaseRepoOptions,
  type Executor,
  type InternalTxContext,
} from '../core/base.js';
import type { Dialect } from '../core/dialect.js';
import { ConnectionError, QueryError, RepoError, UniqueConstraintError } from '../core/errors.js';
import { catalogText, type LiveColumn, type TableShape } from '../core/introspect.js';
import type { IdStrategy, TimestampOptions } from '../core/repo.js';

/**
 * Structural types for the bits of `pg` this adapter touches.
 *
 * `pg` is an optional peer dependency, so importing its types directly would make a
 * SQLite-only install fail to typecheck. These describe the surface actually used.
 */
export interface PgQueryResult {
  rows: Record<string, unknown>[];
}

export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>;
  release?(err?: boolean): void;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>;
  end(): Promise<void>;
}

export interface PostgresConnectionOptions {
  connectionString: string;
  max?: number;
}

export interface PostgresRepoOptions extends Omit<BaseRepoOptions, 'ids' | 'timestamps'> {
  connection: PostgresConnectionOptions | PgPoolLike | PostgresConnection;
  ids?: IdStrategy;
  timestamps?: TimestampOptions;
}

/**
 * One `PostgresConnection` per pool object.
 *
 * The identity is what `repo.with(ctx)` checks, so two repos handed the same pool must
 * resolve to the same connection or they could never share a transaction, which is the
 * whole point of passing a shared pool.
 */
const byPool = new WeakMap<PgPoolLike, PostgresConnection>();

/** A pool plus the identity that lets several repos share one transaction. */
export class PostgresConnection {
  readonly id = Symbol('repolayer.postgres');
  private ended = false;

  constructor(
    readonly pool: PgPoolLike,
    /** True when repolayer created the pool and is therefore responsible for ending it. */
    private readonly owned: boolean,
  ) {}

  /** Returns the connection already wrapping `pool`, or wraps it for the first time. */
  static forPool(pool: PgPoolLike, owned: boolean): PostgresConnection {
    const existing = byPool.get(pool);
    if (existing) return existing;
    const connection = new PostgresConnection(pool, owned);
    byPool.set(pool, connection);
    return connection;
  }

  static async create(options: PostgresConnectionOptions): Promise<PostgresConnection> {
    // Imported lazily so a SQLite-only consumer never loads `pg`, and never needs it
    // installed at all.
    let pg: { Pool: new (config: Record<string, unknown>) => PgPoolLike };
    try {
      pg = (await import('pg')).default;
    } catch (error) {
      throw new ConnectionError(
        'The postgres driver requires the "pg" package. Install it with: npm install pg',
        { cause: error },
      );
    }
    const pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.max ?? 10,
    });
    return PostgresConnection.forPool(pool, true);
  }

  /** Built once per connection: `defaultExecutor()` is called on every query. */
  readonly executor: Executor = {
    query: async (sql, params) => {
      const result = await this.pool.query(sql, params);
      return result.rows;
    },
  };

  async end(): Promise<void> {
    if (this.ended || !this.owned) return;
    this.ended = true;
    await this.pool.end();
  }
}

/** Postgres reports every unique violation as SQLSTATE 23505. */
const UNIQUE_VIOLATION = '23505';

/** Cursor names are generated, never taken from input. */
let cursorCounter = 0;

export class PostgresRepo<T, ID = string> extends BaseRepo<T, ID> {
  override readonly dialect: Dialect = 'postgres';
  private readonly connection: PostgresConnection;

  constructor(options: PostgresRepoOptions, tx: InternalTxContext | null = null) {
    super(
      {
        table: options.table,
        schema: options.schema,
        ids: options.ids ?? 'uuid',
        timestamps: options.timestamps ?? {},
      },
      tx,
    );

    if (options.connection instanceof PostgresConnection) {
      this.connection = options.connection;
    } else if ('connect' in options.connection) {
      this.connection = PostgresConnection.forPool(options.connection, false);
    } else {
      throw new ConnectionError(
        'PostgresRepo needs an open pool. Use createRepo() or PostgresConnection.create(), ' +
          'both of which open one for you, since opening a pool is asynchronous.',
      );
    }
  }

  protected override defaultExecutor(): Executor {
    return this.connection.executor;
  }

  protected override connectionId(): symbol {
    return this.connection.id;
  }

  protected override clone(tx: InternalTxContext | null): this {
    const Ctor = this.constructor as new (
      options: PostgresRepoOptions,
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
   * Every statement in a transaction must run on one client, so the transaction checks
   * one out of the pool and holds it. `release` is called in a `finally`, because a
   * leaked client permanently shrinks the pool and eventually deadlocks the process.
   */
  protected override async acquireTxExecutor(): Promise<{
    executor: Executor;
    release: () => void;
  }> {
    const client = await this.connection.pool.connect();
    return {
      executor: {
        async query(sql, params) {
          const result = await client.query(sql, params);
          return result.rows;
        },
      },
      release: () => client.release?.(),
    };
  }

  /**
   * A real server-side cursor: `DECLARE` inside a transaction, then repeated
   * `FETCH FORWARD n`. Rows never all arrive at the client, which is the entire point.
   *
   * A cursor only exists inside a transaction, so one is opened here when the repo is not
   * already bound to one. The `finally` is doing the load-bearing work: without it a
   * consumer that breaks out of the loop would leak a pooled client, and a leaked client
   * permanently shrinks the pool until the process deadlocks.
   */
  protected override async *openCursor(
    sql: string,
    params: unknown[],
    batchSize: number,
  ): AsyncIterable<Record<string, unknown>[]> {
    cursorCounter += 1;
    const name = `repolayer_cur_${cursorCounter}`;
    // Interpolated into FETCH, so it must be an integer this code produced. BaseRepo
    // validates it before calling; this is the second line of that defense.
    const size = Math.trunc(batchSize);
    if (!Number.isInteger(size) || size < 1) {
      throw new QueryError(`batchSize must be a positive integer, received ${String(batchSize)}`);
    }

    const bound = this.tx !== null;
    const { executor, release } = bound
      ? { executor: this.exec, release: (): void => undefined }
      : await this.acquireTxExecutor();

    let opened = false;
    try {
      if (!bound) await executor.query('BEGIN', []);
      await executor.query(`DECLARE ${name} NO SCROLL CURSOR FOR ${sql}`, params);
      opened = true;

      for (;;) {
        const rows = await executor.query(`FETCH FORWARD ${size} FROM ${name}`, []);
        if (rows.length === 0) break;
        yield rows;
        if (rows.length < size) break;
      }

      if (opened) await executor.query(`CLOSE ${name}`, []);
      opened = false;
      if (!bound) await executor.query('COMMIT', []);
    } catch (error) {
      if (!bound) await executor.query('ROLLBACK', []).catch(() => undefined);
      throw error;
    } finally {
      // Reached when a consumer breaks out of the loop, which is exactly the case that
      // would otherwise leave a cursor open and a client checked out forever.
      if (opened) {
        await executor.query(`CLOSE ${name}`, []).catch(() => undefined);
        if (!bound) await executor.query('COMMIT', []).catch(() => undefined);
      }
      release();
    }
  }

  /**
   * Two catalog reads: `information_schema.columns` for the columns, and `pg_index` for the
   * keys.
   *
   * `pg_index` rather than `information_schema.table_constraints`, because a unique *index*
   * created by a migration tool is not a unique *constraint* and would not appear there.
   * Reporting a missing unique constraint on a table that has a perfectly good unique index
   * would be a false positive on exactly the tables this is meant to reassure people about.
   *
   * The table name is lowered on the way in. repolayer never quotes identifiers, so
   * Postgres folded the name when the table was created, and a config that spells it
   * `Widgets` has to match a catalog holding `widgets`.
   */
  protected override async readTableShape(): Promise<TableShape> {
    const executor = this.exec;
    const rows = await executor.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = lower($1)
        ORDER BY ordinal_position`,
      [this.table],
    );
    if (rows.length === 0) return { exists: false, columns: [], uniqueColumns: [] };

    // indkey[0] rather than ANY(indkey): an index can carry INCLUDE columns alongside its
    // one key column, and ANY would report those as constrained when they are not.
    const keys = await executor.query(
      `SELECT a.attname AS column_name, i.indisprimary
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
        WHERE c.relname = lower($1)
          AND n.nspname = current_schema()
          AND i.indisunique
          AND i.indnkeyatts = 1`,
      [this.table],
    );

    const primaryKeys = new Set<string>();
    const uniqueColumns: string[] = [];
    for (const key of keys) {
      const column = catalogText(key['column_name']);
      if (key['indisprimary'] === true) primaryKeys.add(column);
      else uniqueColumns.push(column);
    }

    const columns: LiveColumn[] = rows.map((row) => ({
      column: catalogText(row['column_name']),
      dataType: catalogText(row['data_type']).toLowerCase(),
      nullable: row['is_nullable'] === 'YES',
      primaryKey: primaryKeys.has(catalogText(row['column_name'])),
      hasDefault: row['column_default'] !== null && row['column_default'] !== undefined,
    }));

    return { exists: true, columns, uniqueColumns };
  }

  protected override mapError(error: unknown): unknown {
    if (error instanceof RepoError) return error;
    const code = (error as { code?: unknown } | null)?.code;
    if (code === UNIQUE_VIOLATION) {
      const detail = (error as { detail?: string }).detail ?? '';
      // Postgres puts the columns in DETAIL: "Key (email)=(a@b.c) already exists."
      const match = /Key \(([^)]+)\)=/.exec(detail);
      const fields = match
        ? (match[1] as string)
            .split(',')
            .map((column) => column.trim().replace(/^"|"$/g, ''))
            .map((column) => this.schema.fieldsByColumn[column] ?? column)
        : [];
      return new UniqueConstraintError(this.table, fields, { cause: error });
    }
    return error;
  }

  override async close(): Promise<void> {
    await this.connection.end();
  }
}

export async function createPostgresRepo<T, ID = string>(
  options: Omit<PostgresRepoOptions, 'connection'> & {
    connection: PostgresConnectionOptions | PgPoolLike | PostgresConnection;
  },
): Promise<PostgresRepo<T, ID>> {
  const connection =
    options.connection instanceof PostgresConnection || 'connect' in options.connection
      ? options.connection
      : await PostgresConnection.create(options.connection);
  return new PostgresRepo<T, ID>({ ...options, connection });
}
