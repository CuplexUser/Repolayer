/**
 * repolayer: define your data access once against `Repo<T>`, then choose the engine.
 *
 * Start on SQLite because it needs no setup, move to Postgres when you need concurrent
 * writers or multiple instances, and change one config value rather than every query.
 */
export { defineSchema, columnFor } from './core/schema.js';
export type {
  FieldDef,
  FieldMap,
  FieldType,
  Infer,
  CreateInput,
  Schema,
} from './core/schema.js';

export { createRepo } from './core/factory.js';
export type { CreateRepoConfig } from './core/factory.js';

export type { Repo, TxContext, IdStrategy, TimestampOptions } from './core/repo.js';
export type {
  FieldFilter,
  Operator,
  OrderBy,
  QueryOptions,
  CompiledQuery,
} from './core/query.js';
export type { Dialect } from './core/dialect.js';

export {
  compileCount,
  compileLimit,
  compileOrderBy,
  compileSelect,
  compileWhere,
  ParamList,
  selectList,
} from './core/query.js';
export { createTableStatements, dropTableStatement } from './core/ddl.js';
export { fromDb, rowToEntity, toDb } from './core/serialize.js';

export { BaseRepo } from './core/base.js';
export type { Executor, BaseRepoOptions } from './core/base.js';

export {
  ConnectionError,
  NotFoundError,
  QueryError,
  RepoError,
  SchemaError,
  UniqueConstraintError,
} from './core/errors.js';
