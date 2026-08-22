import { ConnectionError } from './errors.js';
import type { IdStrategy, Repo, TimestampOptions } from './repo.js';
import type { Schema } from './schema.js';

export interface SqliteDriverConfig {
  driver: 'sqlite';
  connection: { file: string; busyTimeoutMs?: number } | object;
}

export interface PostgresDriverConfig {
  driver: 'postgres';
  connection: { connectionString: string; max?: number } | object;
}

export interface MysqlDriverConfig {
  /** Covers MariaDB too: one adapter, with the flavor detected at connect. */
  driver: 'mysql';
  connection: { connectionString: string; max?: number } | object;
}

export type CreateRepoConfig<T> = (
  SqliteDriverConfig | PostgresDriverConfig | MysqlDriverConfig
) & {
  table: string;
  schema: Schema;
  /** How the primary key is produced. Defaults to 'uuid'. */
  ids?: IdStrategy;
  /**
   * `true` uses the conventional field names `createdAt` and `updatedAt`. Pass an object
   * to name them yourself, or `false`/omit to manage timestamps in application code.
   */
  timestamps?: boolean | TimestampOptions;
  /** Runs `ensureTable()` before returning. Convenient locally, unwise in production. */
  ensureTable?: boolean;
} & Record<never, T>;

function resolveTimestamps(option: boolean | TimestampOptions | undefined): TimestampOptions {
  if (option === true) return { createdAt: 'createdAt', updatedAt: 'updatedAt' };
  if (!option) return {};
  return option;
}

/**
 * The one call site that decides which engine you are on. Everything downstream talks to
 * `Repo<T>` and cannot tell the difference, which is the entire point of the package:
 * moving from SQLite to Postgres is a change to this config, not to your queries.
 *
 * The adapter module is imported lazily, so a SQLite-only project never loads `pg` and
 * does not need it installed.
 */
export async function createRepo<T, ID = string>(
  config: CreateRepoConfig<T>,
): Promise<Repo<T, ID>> {
  const timestamps = resolveTimestamps(config.timestamps);
  const ids = config.ids ?? 'uuid';
  let repo: Repo<T, ID>;

  if (config.driver === 'sqlite') {
    const { SqliteRepo, SqliteConnection, openSqlite } = await import('../sqlite/index.js');
    const connection =
      config.connection instanceof SqliteConnection
        ? config.connection
        : openSqlite(config.connection as { file: string; busyTimeoutMs?: number });
    repo = new SqliteRepo<T, ID>({
      table: config.table,
      schema: config.schema,
      connection,
      ids,
      timestamps,
    });
  } else if (config.driver === 'postgres') {
    const { createPostgresRepo } = await import('../postgres/index.js');
    repo = await createPostgresRepo<T, ID>({
      table: config.table,
      schema: config.schema,
      connection: config.connection as { connectionString: string },
      ids,
      timestamps,
    });
  } else if (config.driver === 'mysql') {
    const { createMysqlRepo } = await import('../mysql/index.js');
    repo = await createMysqlRepo<T, ID>({
      table: config.table,
      schema: config.schema,
      connection: config.connection as { connectionString: string },
      ids,
      timestamps,
    });
  } else {
    throw new ConnectionError(
      `Unknown driver ${JSON.stringify((config as { driver: string }).driver)}. ` +
        `Supported drivers: "sqlite", "postgres", "mysql" (which covers MariaDB).`,
    );
  }

  if (config.ensureTable) await repo.ensureTable();
  return repo;
}
