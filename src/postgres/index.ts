import {
  BaseRepo,
  type BaseRepoOptions,
  type Executor,
  type InternalTxContext,
} from '../core/base.js';
import type { Dialect } from '../core/dialect.js';
import { ConnectionError, RepoError, UniqueConstraintError } from '../core/errors.js';
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
      pg = (await import('pg')).default as typeof pg;
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

  get executor(): Executor {
    const pool = this.pool;
    return {
      async query(sql, params) {
        const result = await pool.query(sql, params);
        return result.rows;
      },
    };
  }

  async end(): Promise<void> {
    if (this.ended || !this.owned) return;
    this.ended = true;
    await this.pool.end();
  }
}

/** Postgres reports every unique violation as SQLSTATE 23505. */
const UNIQUE_VIOLATION = '23505';

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
