/**
 * repolayer: define your data access once against `Repo<T>`, then choose the engine.
 *
 * Start on SQLite because it needs no setup, move to Postgres when you need concurrent
 * writers or multiple instances, and change one config value rather than every query.
 */
export { defineSchema, columnFor } from './core/schema.js';
export type { FieldDef, FieldMap, FieldType, Infer, CreateInput, Schema } from './core/schema.js';

export { createRepo } from './core/factory.js';
export type {
  CreateRepoConfig,
  MysqlDriverConfig,
  PostgresDriverConfig,
  SqliteDriverConfig,
} from './core/factory.js';

export type {
  IdStrategy,
  Page,
  PageOptions,
  Repo,
  StreamOptions,
  TimestampOptions,
  TxContext,
} from './core/repo.js';
export type {
  AndGroup,
  CompiledQuery,
  FieldFilter,
  Filter,
  Operator,
  OrderBy,
  OrGroup,
  QueryOptions,
} from './core/query.js';
export type { Dialect, MysqlFlavor } from './core/dialect.js';

export {
  compileCount,
  compileLimit,
  compileOrderBy,
  compileSelect,
  compileWhere,
  normalizeWhere,
  ParamList,
  selectList,
} from './core/query.js';
export { createTableStatements, dropTableStatement } from './core/ddl.js';
export { diffTable } from './core/introspect.js';
export type {
  FindingKind,
  LiveColumn,
  TableDiff,
  TableFinding,
  TableShape,
} from './core/introspect.js';
export { decodeCursor, encodeCursor, keysetFilter, resolveSortKeys } from './core/keyset.js';
export { fromDb, rowToEntity, toDb } from './core/serialize.js';

export { BaseRepo } from './core/base.js';
export type { BaseRepoOptions, ExecuteResult, Executor } from './core/base.js';

export {
  ConnectionError,
  NotFoundError,
  QueryError,
  RepoError,
  SchemaError,
  UniqueConstraintError,
} from './core/errors.js';
