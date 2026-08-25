import { describe, expect, it } from 'vitest';

import * as root from '../../src/index.js';
import * as sqlite from '../../src/sqlite/index.js';
import * as postgres from '../../src/postgres/index.js';
import * as testing from '../../src/testing/index.js';

/**
 * The public surface, pinned.
 *
 * Removing or renaming an export is a breaking change for every consumer, and until this
 * test existed the only thing that would have noticed was the packaged-consumer job in CI,
 * and then only for the handful of names it happens to touch. Adding an export means adding
 * a line here on purpose; losing one means an unmistakable diff.
 */

const names = (module: object): string[] => Object.keys(module).sort();

describe('public exports', () => {
  it('exports exactly this surface from "repolayer"', () => {
    expect(names(root)).toEqual([
      'BaseRepo',
      'ConnectionError',
      'NotFoundError',
      'ParamList',
      'QueryError',
      'RepoError',
      'SchemaError',
      'UniqueConstraintError',
      'columnFor',
      'compileCount',
      'compileLimit',
      'compileOrderBy',
      'compileSelect',
      'compileWhere',
      'createRepo',
      'createTableStatements',
      'decodeCursor',
      'defineSchema',
      'diffTable',
      'dropTableStatement',
      'encodeCursor',
      'fromDb',
      'keysetFilter',
      'normalizeWhere',
      'resolveSortKeys',
      'rowToEntity',
      'selectList',
      'toDb',
    ]);
  });

  it('exports exactly this surface from "repolayer/sqlite"', () => {
    expect(names(sqlite)).toEqual([
      'SqliteConnection',
      'SqliteRepo',
      'createSqliteRepo',
      'openSqlite',
    ]);
  });

  it('exports exactly this surface from "repolayer/postgres"', () => {
    expect(names(postgres)).toEqual(['PostgresConnection', 'PostgresRepo', 'createPostgresRepo']);
  });

  it('exports exactly this surface from "repolayer/testing"', () => {
    expect(names(testing)).toEqual([
      'MemoryRepo',
      'MemoryStore',
      'createMemoryRepo',
      'noteSchema',
      'runConformanceSuite',
      'widerWidgetSchema',
      'widgetSchema',
    ]);
  });

  it('keeps every error class rooted at RepoError, so one catch can cover them all', () => {
    for (const Ctor of [
      root.ConnectionError,
      root.NotFoundError,
      root.QueryError,
      root.SchemaError,
      root.UniqueConstraintError,
    ]) {
      expect(Object.create(Ctor.prototype)).toBeInstanceOf(root.RepoError);
    }
  });
});
