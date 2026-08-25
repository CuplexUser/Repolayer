import {
  BaseRepo,
  type BaseRepoOptions,
  type ExecuteResult,
  type Executor,
  type InternalTxContext,
} from '../core/base.js';
import type { Dialect, MysqlFlavor } from '../core/dialect.js';
import { ConnectionError, RepoError, UniqueConstraintError } from '../core/errors.js';
import { catalogText, type LiveColumn, type TableShape } from '../core/introspect.js';
import type { IdStrategy, TimestampOptions } from '../core/repo.js';

/**
 * The MySQL and MariaDB adapter.
 *
 * One adapter for both servers. They are the same dialect for everything the query shape
 * touches, and the two places they genuinely differ (how a duplicate-key error reads, and
 * whether the server parses JSON itself) are handled by detecting the flavor at connect
 * time rather than by forking the compiler.
 *
 * The interesting difference from the other two adapters is that MySQL has no `RETURNING`.
 * `create` and `update` therefore cost a write plus a keyed read, run on one connection
 * inside a transaction so the read cannot see anyone else's work. `BaseRepo` owns that
 * choreography; all this adapter does is declare that it has no `RETURNING` and provide
 * the `execute()` that reports what a write touched.
 */

/**
 * Structural types for the bits of `mysql2` this adapter touches.
 *
 * `mysql2` is an optional peer dependency, so importing its types directly would make a
 * SQLite-only install fail to typecheck.
 */
export interface MysqlResultSetHeader {
  affectedRows?: number;
  insertId?: number;
}

export interface MysqlConnectionLike {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  release?(): void;
}

export interface MysqlPoolLike {
  getConnection(): Promise<MysqlConnectionLike>;
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

export interface MysqlConnectionOptions {
  /** A `mysql://user:pass@host:port/database` URL. */
  connectionString: string;
  /** Maximum pooled connections. Defaults to 10. */
  max?: number;
}

export interface MysqlRepoOptions extends Omit<BaseRepoOptions, 'ids' | 'timestamps'> {
  connection: MysqlConnectionOptions | MysqlPoolLike | MysqlConnection;
  ids?: IdStrategy;
  timestamps?: TimestampOptions;
}

/** MySQL and MariaDB both report a duplicate key as error 1062. */
const DUPLICATE_ENTRY = 1062;

/**
 * Connection options that are not preferences.
 *
 * Every one of these exists to make a specific conformance case pass. Leaving any of them
 * to the caller would mean the adapter behaves differently depending on how the pool was
 * built, which is exactly the kind of variation the suite is meant to rule out.
 */
const REQUIRED_DRIVER_OPTIONS = {
  // Without this, affectedRows counts rows whose values actually *changed*, so updating a
  // column to the value it already holds would report zero, and `update` would raise
  // NotFoundError for a row that is plainly there.
  flags: ['FOUND_ROWS'],
  // mysql2 parses MySQL's native JSON columns but not MariaDB's LONGTEXT-backed ones.
  // Taking the raw text on both means one parse path, and it keeps a JSON value that is
  // itself a string from being unwrapped twice.
  jsonStrings: true,
  // DATETIME carries no zone. Reading it as text and parsing it as UTC removes any
  // dependence on the driver's or the server's timezone setting.
  dateStrings: true,
  // A BIGINT past 2^53 arrives as a string and hits the safe-integer guard in `fromDb`,
  // rather than silently losing digits on the way through a JS number.
  supportBigNumbers: true,
  bigNumberStrings: true,
  // Keeps a DECIMAL from being rounded through a float, on the rare schema that has one.
  decimalNumbers: false,
} as const;

/** One `MysqlConnection` per pool object, so repos sharing a pool can share a transaction. */
const byPool = new WeakMap<MysqlPoolLike, MysqlConnection>();

/** Reads the rows out of what mysql2 returns, which is always a [result, fields] pair. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  const [payload] = result as [unknown, unknown];
  return Array.isArray(payload) ? (payload as Record<string, unknown>[]) : [];
}

function headerOf(result: unknown): MysqlResultSetHeader {
  const [payload] = result as [unknown, unknown];
  return Array.isArray(payload) ? {} : (payload ?? {});
}

/** Wraps a mysql2 pool or single connection in the two calls `BaseRepo` makes. */
function executorFor(source: {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
}): Executor {
  return {
    async query(sql, params) {
      return rowsOf(await source.query(sql, params));
    },
    async execute(sql, params): Promise<ExecuteResult> {
      const result = await source.query(sql, params);
      const header = headerOf(result);
      return {
        rows: rowsOf(result),
        rowCount: header.affectedRows ?? 0,
        insertId: header.insertId ?? null,
      };
    },
  };
}

/** A pool plus the identity that lets several repos share one transaction. */
export class MysqlConnection {
  readonly id = Symbol('repolayer.mysql');
  /** Which server is on the other end. Detected once, at connect. */
  flavor: MysqlFlavor = 'mysql';
  private ended = false;

  constructor(
    readonly pool: MysqlPoolLike,
    /** True when repolayer created the pool and is therefore responsible for ending it. */
    private readonly owned: boolean,
  ) {}

  static forPool(pool: MysqlPoolLike, owned: boolean): MysqlConnection {
    const existing = byPool.get(pool);
    if (existing) return existing;
    const connection = new MysqlConnection(pool, owned);
    byPool.set(pool, connection);
    return connection;
  }

  static async create(options: MysqlConnectionOptions): Promise<MysqlConnection> {
    // Imported lazily so a consumer on another engine never loads mysql2, and never needs
    // it installed at all.
    let mysql: {
      createPool: (config: Record<string, unknown>) => MysqlPoolLike;
    };
    try {
      mysql = await import('mysql2/promise');
    } catch (error) {
      throw new ConnectionError(
        'The mysql driver requires the "mysql2" package. Install it with: npm install mysql2',
        { cause: error },
      );
    }

    const pool = mysql.createPool({
      uri: options.connectionString,
      connectionLimit: options.max ?? 10,
      ...REQUIRED_DRIVER_OPTIONS,
    });

    const connection = MysqlConnection.forPool(pool, true);
    await connection.detectFlavor();
    return connection;
  }

  /**
   * Asks the server what it is.
   *
   * MariaDB reports a version string containing "MariaDB". The answer only decides error
   * message parsing and a couple of DDL details, so a failed probe is not fatal: the
   * MySQL reading is the safe default.
   */
  async detectFlavor(): Promise<MysqlFlavor> {
    try {
      const rows = rowsOf(await this.pool.query('SELECT VERSION() AS version'));
      const reported = rows[0]?.['version'];
      const version = typeof reported === 'string' ? reported : '';
      this.flavor = /mariadb/i.test(version) ? 'mariadb' : 'mysql';
    } catch {
      this.flavor = 'mysql';
    }
    return this.flavor;
  }

  readonly executor: Executor = executorFor({
    query: (sql, params) => this.pool.query(sql, params),
  });

  async end(): Promise<void> {
    if (this.ended || !this.owned) return;
    this.ended = true;
    await this.pool.end();
  }
}

export class MysqlRepo<T, ID = string> extends BaseRepo<T, ID> {
  override readonly dialect: Dialect = 'mysql';
  private readonly connection: MysqlConnection;

  constructor(options: MysqlRepoOptions, tx: InternalTxContext | null = null) {
    super(
      {
        table: options.table,
        schema: options.schema,
        ids: options.ids ?? 'uuid',
        timestamps: options.timestamps ?? {},
      },
      tx,
    );

    if (options.connection instanceof MysqlConnection) {
      this.connection = options.connection;
    } else if ('getConnection' in options.connection) {
      this.connection = MysqlConnection.forPool(options.connection, false);
    } else {
      throw new ConnectionError(
        'MysqlRepo needs an open pool. Use createRepo() or MysqlConnection.create(), both ' +
          'of which open one for you, since opening a pool is asynchronous.',
      );
    }
  }

  /** Which server this repo is talking to. Useful in tests and in bug reports. */
  get flavor(): MysqlFlavor {
    return this.connection.flavor;
  }

  /**
   * MySQL has no `RETURNING`, on either flavor.
   *
   * MariaDB 10.5 does support it for INSERT and DELETE but not UPDATE. Using it there
   * would give the two flavors different numbers of round trips and different failure
   * modes for no behavioral gain, so both take the same path.
   */
  protected override get supportsReturning(): boolean {
    return false;
  }

  protected override defaultExecutor(): Executor {
    return this.connection.executor;
  }

  protected override connectionId(): symbol {
    return this.connection.id;
  }

  protected override clone(tx: InternalTxContext | null): this {
    const Ctor = this.constructor as new (
      options: MysqlRepoOptions,
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
   * Every statement in a transaction must run on one connection, so the transaction checks
   * one out of the pool and holds it. `release` runs in a `finally`, because a leaked
   * connection permanently shrinks the pool and eventually deadlocks the process.
   */
  protected override async acquireTxExecutor(): Promise<{
    executor: Executor;
    release: () => void;
  }> {
    const client = await this.connection.pool.getConnection();
    return {
      executor: executorFor(client),
      release: () => client.release?.(),
    };
  }

  /**
   * A cursor over a MySQL result set.
   *
   * Deliberately not a server-side cursor: MySQL has none for a plain SELECT outside a
   * stored procedure. mysql2 does offer a streaming query, but only on the callback API,
   * and reaching for it would mean a second code path with its own lifetime rules. The
   * whole result is fetched once and handed out in batches, which keeps `stream` correct
   * everywhere while being honest that on MySQL it does not reduce peak memory. The
   * limitation is documented rather than papered over.
   */
  protected override async *openCursor(
    sql: string,
    params: unknown[],
    batchSize: number,
  ): AsyncIterable<Record<string, unknown>[]> {
    const rows = await this.exec.query(sql, params);
    for (let i = 0; i < rows.length; i += batchSize) {
      yield rows.slice(i, i + batchSize);
    }
  }

  /**
   * `DATA_TYPE`, never `COLUMN_TYPE`. MariaDB reports `bigint(20)` in the latter where
   * MySQL 8 reports `bigint`, and the whole premise of this adapter is that one code path
   * serves both flavors.
   *
   * `COLLATION_NAME` is read because it is the highest-value thing this check can catch on
   * MySQL: `ddl.ts` creates string columns utf8mb4_bin on purpose, and a table built by
   * anything else almost certainly used the case-insensitive server default.
   */
  protected override async readTableShape(): Promise<TableShape> {
    const executor = this.exec;
    const rows = await executor.query(
      `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME,
              COLUMN_KEY, EXTRA
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [this.table],
    );
    if (rows.length === 0) return { exists: false, columns: [], uniqueColumns: [] };

    const columns: LiveColumn[] = rows.map((row) => {
      const collation = catalogText(row['COLLATION_NAME']);
      return {
        column: catalogText(row['COLUMN_NAME']),
        dataType: catalogText(row['DATA_TYPE']).toLowerCase(),
        nullable: catalogText(row['IS_NULLABLE']).toUpperCase() === 'YES',
        primaryKey: catalogText(row['COLUMN_KEY']).toUpperCase() === 'PRI',
        // An AUTO_INCREMENT column reports no COLUMN_DEFAULT, but the engine supplies one,
        // so an insert that omits it still succeeds.
        hasDefault:
          (row['COLUMN_DEFAULT'] !== null && row['COLUMN_DEFAULT'] !== undefined) ||
          /auto_increment/i.test(catalogText(row['EXTRA'])),
        ...(collation === '' ? {} : { collation: collation.toLowerCase() }),
      };
    });

    // Grouped in JS rather than with a HAVING subquery, because what is wanted is the set
    // of unique indexes covering exactly one column, and that reads far better here.
    const stats = await executor.query(
      `SELECT INDEX_NAME, COLUMN_NAME
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND NON_UNIQUE = 0
          AND INDEX_NAME <> 'PRIMARY'`,
      [this.table],
    );
    const byIndex = new Map<string, string[]>();
    for (const stat of stats) {
      const name = catalogText(stat['INDEX_NAME']);
      const members = byIndex.get(name) ?? [];
      members.push(catalogText(stat['COLUMN_NAME']));
      byIndex.set(name, members);
    }
    const uniqueColumns = [...byIndex.values()]
      .filter((members) => members.length === 1)
      .map((members) => members[0] as string);

    return { exists: true, columns, uniqueColumns };
  }

  protected override mapError(error: unknown): unknown {
    if (error instanceof RepoError) return error;
    const errno = (error as { errno?: unknown } | null)?.errno;
    if (errno !== DUPLICATE_ENTRY) return error;

    const message = error instanceof Error ? error.message : String(error);
    // MySQL 8 says: Duplicate entry 'x' for key 'widgets.slug'
    // MariaDB says: Duplicate entry 'x' for key 'slug'
    const match = /for key '([^']+)'/.exec(message);
    const key = match?.[1]?.split('.').pop() ?? '';
    // The index is named after its column by the DDL this package generates. PRIMARY is
    // the one index MySQL names for itself.
    const column = key === 'PRIMARY' ? (this.schema.columns[this.schema.primaryKey] ?? '') : key;
    const field = this.schema.fieldsByColumn[column] ?? column;

    return new UniqueConstraintError(this.table, field ? [field] : [], { cause: error });
  }

  override async close(): Promise<void> {
    await this.connection.end();
  }
}

export async function createMysqlRepo<T, ID = string>(
  options: Omit<MysqlRepoOptions, 'connection'> & {
    connection: MysqlConnectionOptions | MysqlPoolLike | MysqlConnection;
  },
): Promise<MysqlRepo<T, ID>> {
  const connection =
    options.connection instanceof MysqlConnection || 'getConnection' in options.connection
      ? options.connection
      : await MysqlConnection.create(options.connection);
  return new MysqlRepo<T, ID>({ ...options, connection });
}
