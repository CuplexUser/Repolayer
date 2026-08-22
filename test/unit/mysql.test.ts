import { describe, expect, it } from 'vitest';

import { createTableStatements } from '../../src/core/ddl.js';
import { NotFoundError, UniqueConstraintError } from '../../src/core/errors.js';
import { compileSelect, type QueryOptions } from '../../src/core/query.js';
import { defineSchema } from '../../src/core/schema.js';
import { fromDb, toDb } from '../../src/core/serialize.js';
import { MysqlConnection, MysqlRepo, type MysqlPoolLike } from '../../src/mysql/index.js';

/**
 * Everything about the MySQL and MariaDB adapter that can be checked without a server.
 *
 * The conformance suite is the real proof and it runs in CI against both engines. What is
 * here is the part that would otherwise only ever be exercised on a machine with Docker:
 * the SQL the compiler emits for this dialect, the storage conversions, the DDL, and the
 * write-then-read choreography that stands in for the RETURNING this engine does not have.
 */

const schema = defineSchema({
  id: { type: 'string', primaryKey: true },
  name: { type: 'string' },
  slug: { type: 'string', unique: true },
  quantity: { type: 'integer' },
  weight: { type: 'number' },
  active: { type: 'boolean' },
  meta: { type: 'json', nullable: true },
  releasedAt: { type: 'date', nullable: true, column: 'released_at' },
});

interface Row {
  id: string;
  name: string;
  slug: string;
  quantity: number;
  weight: number;
  active: boolean;
  meta: unknown | null;
  releasedAt: Date | null;
}

const select = (query: QueryOptions<Row> | undefined): { sql: string; params: unknown[] } =>
  compileSelect<Row>(schema, 'widgets', query, 'mysql');

describe('mysql compiler', () => {
  it('uses ? placeholders, the same as sqlite', () => {
    const { sql, params } = select({
      where: [
        { field: 'name', op: 'eq', value: 'a' },
        { field: 'quantity', op: 'gt', value: 2 },
      ],
    });
    expect(sql).toContain('WHERE name = ? AND quantity > ?');
    expect(params).toEqual(['a', 2]);
  });

  it('forces a binary collation on like, so it is case sensitive whatever the column is', () => {
    // MySQL decides LIKE case sensitivity by collation, and the server default is case
    // insensitive. Without this, `like` and `ilike` would mean the same thing.
    const { sql } = select({ where: [{ field: 'name', op: 'like', value: 'A%' }] });
    expect(sql).toContain('name LIKE ? COLLATE utf8mb4_bin');
  });

  it('lowers both sides for ilike, which works on either flavor', () => {
    const { sql } = select({ where: [{ field: 'name', op: 'ilike', value: 'a%' }] });
    expect(sql).toContain('LOWER(name) LIKE LOWER(?)');
  });

  it('reproduces NULLS LAST and NULLS FIRST, which MySQL cannot spell', () => {
    const { sql } = select({
      orderBy: [
        { field: 'releasedAt', direction: 'asc' },
        { field: 'name', direction: 'desc' },
      ],
    });
    // (col IS NULL) is 0 for a value and 1 for a null, so ASC puts nulls last and DESC
    // puts them first, exactly as the NULLS LAST/FIRST the other engines emit.
    expect(sql).toContain(
      ' ORDER BY (released_at IS NULL) ASC, released_at ASC, (name IS NULL) DESC, name DESC',
    );
    expect(sql).not.toContain('NULLS');
  });

  it('spells an unbounded limit the way MySQL accepts', () => {
    // Neither `LIMIT ALL` nor `LIMIT -1` parses here.
    expect(select({ offset: 5 }).sql).toContain(' LIMIT 18446744073709551615 OFFSET ?');
  });

  it('collapses an empty in and nin to constants, as every dialect does', () => {
    expect(select({ where: [{ field: 'slug', op: 'in', value: [] }] }).sql).toContain(
      'WHERE 1 = 0',
    );
    expect(select({ where: [{ field: 'slug', op: 'nin', value: [] }] }).sql).toContain(
      'WHERE 1 = 1',
    );
  });

  it('keeps null rows in ne and nin, as every dialect does', () => {
    expect(select({ where: [{ field: 'name', op: 'ne', value: 'a' }] }).sql).toContain(
      '(name <> ? OR name IS NULL)',
    );
  });

  it('compiles filter trees with the same parentheses as the other dialects', () => {
    const { sql } = select({
      where: [
        { field: 'active', op: 'eq', value: true },
        {
          or: [
            { field: 'quantity', op: 'gt', value: 10 },
            { field: 'name', op: 'eq', value: 'Anvil' },
          ],
        },
      ],
    });
    expect(sql).toContain('WHERE active = ? AND (quantity > ? OR name = ?)');
  });
});

describe('mysql storage types', () => {
  it('writes a boolean as 0 or 1, because TINYINT(1) has no true', () => {
    expect(toDb(true, 'boolean', 'mysql', 'active')).toBe(1);
    expect(toDb(false, 'boolean', 'mysql', 'active')).toBe(0);
    expect(fromDb(1, 'boolean', 'mysql', 'active')).toBe(true);
    expect(fromDb(0, 'boolean', 'mysql', 'active')).toBe(false);
  });

  it('writes a date as a zoneless UTC DATETIME and reads it back as the same instant', () => {
    const date = new Date('2024-03-05T06:07:08.123Z');
    const stored = toDb(date, 'date', 'mysql', 'releasedAt');
    expect(stored).toBe('2024-03-05 06:07:08.123');

    // What the server hands back, at DATETIME(6) precision and with no zone on it.
    const read = fromDb('2024-03-05 06:07:08.123000', 'date', 'mysql', 'releasedAt');
    expect(read).toBeInstanceOf(Date);
    expect((read as Date).toISOString()).toBe(date.toISOString());
  });

  it('reads a DATETIME as UTC rather than as local time', () => {
    // The bug this prevents: `new Date('2024-03-05 06:07:08')` is local time, so the same
    // row would read as a different instant depending on where the process runs.
    const read = fromDb('2024-03-05 06:07:08.000000', 'date', 'mysql', 'releasedAt') as Date;
    expect(read.getTime()).toBe(Date.parse('2024-03-05T06:07:08.000Z'));
  });

  it('round trips json, including a value that is itself a string', () => {
    const meta = { tags: ['a', 'b'], nested: { n: 1, missing: null } };
    const stored = toDb(meta, 'json', 'mysql', 'meta') as string;
    expect(fromDb(stored, 'json', 'mysql', 'meta')).toEqual(meta);

    // With jsonStrings the driver hands back raw text on both flavors, so this parses once
    // and stays a string. Letting mysql2 parse it would unwrap it twice on MySQL and not
    // at all on MariaDB.
    const asString = toDb('plain string', 'json', 'mysql', 'meta') as string;
    expect(fromDb(asString, 'json', 'mysql', 'meta')).toBe('plain string');
  });

  it('reads a BIGINT that arrived as a string, and refuses one that lost precision', () => {
    expect(fromDb('9007199254740991', 'integer', 'mysql', 'quantity')).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => fromDb('9007199254740993', 'integer', 'mysql', 'quantity')).toThrow(
      /safe integer range/,
    );
  });

  it('reads a TEXT column that arrived as a Buffer', () => {
    const buffer = new TextEncoder().encode('Anvil');
    expect(fromDb(buffer, 'string', 'mysql', 'name')).toBe('Anvil');
  });
});

describe('mysql ddl', () => {
  it('maps every field type onto its MySQL column type', () => {
    const [sql] = createTableStatements(schema, 'widgets', 'mysql');
    expect(sql).toContain('quantity BIGINT NOT NULL');
    expect(sql).toContain('weight DOUBLE NOT NULL');
    expect(sql).toContain('active TINYINT(1) NOT NULL');
    expect(sql).toContain('released_at DATETIME(6)');
    // Deliberately not the native JSON type: that column holds a normalized document, and
    // comparing it against the text `toDb` produced does not match on MySQL. LONGTEXT is
    // what MariaDB's JSON alias already is, so both flavors compare the same bytes.
    expect(sql).toContain('meta LONGTEXT');
  });

  it('creates string columns case sensitive rather than taking the server default', () => {
    // The server default is a case-insensitive collation, under which `=`, `in`, `unique`,
    // and ORDER BY on text would all behave differently than on SQLite and Postgres.
    const [sql] = createTableStatements(schema, 'widgets', 'mysql');
    expect(sql).toContain('CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
  });

  it('uses VARCHAR where a column has to be indexable and TEXT otherwise', () => {
    // MySQL cannot index a TEXT column without a prefix length.
    const [sql] = createTableStatements(schema, 'widgets', 'mysql');
    expect(sql).toContain('id VARCHAR(255)');
    expect(sql).toContain('slug VARCHAR(255)');
    expect(sql).toMatch(/name TEXT/);
  });

  it('uses AUTO_INCREMENT for a generated key', () => {
    const numeric = defineSchema({
      id: { type: 'integer', primaryKey: true },
      name: { type: 'string' },
    });
    const [sql] = createTableStatements(numeric, 't', 'mysql', 'autoincrement');
    expect(sql).toContain('id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY');
  });
});

/** Records every statement, and replays canned mysql2 [result, fields] pairs. */
function fakePool(results: unknown[] = []): MysqlPoolLike & {
  statements: string[];
  released: number;
} {
  const statements: string[] = [];
  const queue = [...results];
  const run = async (sql: string): Promise<[unknown, unknown]> => {
    statements.push(sql);
    return [queue.shift() ?? [], []];
  };
  const pool = {
    statements,
    released: 0,
    async query(sql: string) {
      return run(sql);
    },
    async getConnection() {
      return {
        query: (sql: string) => run(sql),
        release: () => {
          pool.released += 1;
        },
      };
    },
    async end() {
      /* nothing to close */
    },
  };
  return pool;
}

function repoOn(pool: MysqlPoolLike, ids: 'uuid' | 'autoincrement' = 'uuid'): MysqlRepo<Row> {
  return new MysqlRepo<Row>({ table: 'widgets', schema, connection: pool, ids, timestamps: {} });
}

const widget = (over: Partial<Row> = {}): Partial<Row> => ({
  name: 'Anvil',
  slug: 'anvil',
  quantity: 1,
  weight: 1.5,
  active: true,
  meta: null,
  releasedAt: null,
  ...over,
});

describe('mysql writes without RETURNING', () => {
  const storedRow = (id: string): Record<string, unknown> => ({
    id,
    name: 'Anvil',
    slug: 'anvil',
    quantity: 1,
    weight: 1.5,
    active: 1,
    meta: null,
    released_at: null,
  });

  it('inserts, then reads the row back on the same connection inside a transaction', async () => {
    // BEGIN, INSERT, SELECT, COMMIT
    const pool = fakePool([[], { affectedRows: 1, insertId: 0 }, [storedRow('given')], []]);
    const repo = repoOn(pool);

    const created = await repo.create(widget({ id: 'given' }));

    expect(created.id).toBe('given');
    expect(created.active).toBe(true);
    expect(pool.statements[0]).toBe('BEGIN');
    expect(pool.statements[1]).toMatch(/^INSERT INTO widgets/);
    expect(pool.statements[1]).not.toContain('RETURNING');
    expect(pool.statements[2]).toContain('WHERE id IN (?)');
    expect(pool.statements[3]).toBe('COMMIT');
    expect(pool.released).toBe(1);
  });

  it('names auto-increment rows from the insert id and the row count', async () => {
    const numeric = defineSchema({
      id: { type: 'integer', primaryKey: true },
      name: { type: 'string' },
    });
    const pool = fakePool([
      [],
      { affectedRows: 3, insertId: 41 },
      [
        { id: 41, name: 'a' },
        { id: 42, name: 'b' },
        { id: 43, name: 'c' },
      ],
      [],
    ]);
    const repo = new MysqlRepo<{ id: number; name: string }>({
      table: 'widgets',
      schema: numeric,
      connection: pool,
      ids: 'autoincrement',
      timestamps: {},
    });

    const created = await repo.createMany([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);

    // A single multi-row INSERT is assigned a contiguous block of keys.
    expect(created.map((r) => r.id)).toEqual([41, 42, 43]);
    expect(pool.statements[2]).toContain('WHERE id IN (?, ?, ?)');
  });

  it('returns a batch in the order it was written, not the order the SELECT replied', async () => {
    // IN does not preserve the order of its list, so a driver is free to hand the rows
    // back in any order. createMany still has to answer in insertion order.
    const pool = fakePool([
      [],
      { affectedRows: 2, insertId: 0 },
      [storedRow('second'), storedRow('first')],
      [],
    ]);
    const repo = repoOn(pool);

    const created = await repo.createMany([
      widget({ id: 'first' }),
      widget({ id: 'second', slug: 'other' }),
    ]);

    expect(created.map((r) => r.id)).toEqual(['first', 'second']);
  });

  it('joins an open transaction rather than nesting a pointless savepoint', async () => {
    const pool = fakePool([[], { affectedRows: 1, insertId: 0 }, [storedRow('x')], []]);
    const repo = repoOn(pool);

    await repo.withTransaction(async (tx) => tx.create(widget({ id: 'x' })));

    expect(pool.statements.filter((sql) => sql === 'BEGIN')).toHaveLength(1);
    expect(pool.statements.filter((sql) => sql.startsWith('SAVEPOINT'))).toHaveLength(0);
    expect(pool.released).toBe(1);
  });

  it('reads update from the matched count, not from the changed count', async () => {
    // With FOUND_ROWS set, an update that writes the value a row already holds still
    // reports 1. Without it this would raise NotFoundError for a row that is right there.
    const pool = fakePool([[], { affectedRows: 1 }, [storedRow('x')], []]);
    const repo = repoOn(pool);

    const updated = await repo.update('x', { name: 'Anvil' });

    expect(updated.id).toBe('x');
    expect(pool.statements[1]).toMatch(/^UPDATE widgets SET/);
    expect(pool.statements[1]).not.toContain('RETURNING');
  });

  it('raises NotFoundError when an update matches nothing', async () => {
    const pool = fakePool([[], { affectedRows: 0 }]);
    const repo = repoOn(pool);
    await expect(repo.update('missing', { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('takes the row count straight from delete and updateMany, with no extra query', async () => {
    const deletePool = fakePool([{ affectedRows: 4 }]);
    expect(await repoOn(deletePool).deleteMany()).toBe(4);
    expect(deletePool.statements[0]).toBe('DELETE FROM widgets');

    const updatePool = fakePool([{ affectedRows: 2 }]);
    expect(await repoOn(updatePool).updateMany(undefined, { name: 'x' })).toBe(2);
    expect(updatePool.statements[0]).toMatch(/^UPDATE widgets SET name = \?$/);
  });

  it('raises NotFoundError when a delete by id matches nothing', async () => {
    const pool = fakePool([{ affectedRows: 0 }]);
    await expect(repoOn(pool).delete('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('writes an empty insert with MySQL grammar rather than DEFAULT VALUES', async () => {
    const bare = defineSchema({ id: { type: 'integer', primaryKey: true } });
    const pool = fakePool([[], { affectedRows: 1, insertId: 7 }, [{ id: 7 }], []]);
    const repo = new MysqlRepo<{ id: number }>({
      table: 'widgets',
      schema: bare,
      connection: pool,
      ids: 'autoincrement',
      timestamps: {},
    });

    await repo.create({});
    expect(pool.statements[1]).toBe('INSERT INTO widgets () VALUES ()');
  });
});

describe('mysql error mapping', () => {
  const duplicate = (message: string): Error & { errno: number } =>
    Object.assign(new Error(message), { errno: 1062 });

  async function failingRepo(error: unknown): Promise<MysqlRepo<Row>> {
    const pool: MysqlPoolLike = {
      async query() {
        throw error;
      },

      async getConnection() {
        return {
          query: async () => {
            throw error;
          },
          release: () => undefined,
        };
      },
      async end() {
        /* nothing to close */
      },
    };
    return Promise.resolve(repoOn(pool));
  }

  it('maps a MySQL 8 duplicate key onto the schema field', async () => {
    const repo = await failingRepo(duplicate("Duplicate entry 'taken' for key 'widgets.slug'"));
    const error = await repo.create(widget({ id: 'a' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UniqueConstraintError);
    expect((error as UniqueConstraintError).fields).toEqual(['slug']);
  });

  it('maps a MariaDB duplicate key, which names the index without the table', async () => {
    const repo = await failingRepo(duplicate("Duplicate entry 'taken' for key 'slug'"));
    const error = await repo.create(widget({ id: 'a' })).catch((e: unknown) => e);
    expect((error as UniqueConstraintError).fields).toEqual(['slug']);
  });

  it('maps a duplicate primary key, which MySQL calls PRIMARY', async () => {
    const repo = await failingRepo(duplicate("Duplicate entry 'x' for key 'PRIMARY'"));
    const error = await repo.create(widget({ id: 'x' })).catch((e: unknown) => e);
    expect((error as UniqueConstraintError).fields).toEqual(['id']);
  });

  it('leaves an unrelated driver error alone', async () => {
    const other = Object.assign(new Error('server has gone away'), { errno: 2006 });
    const repo = await failingRepo(other);
    await expect(repo.create(widget({ id: 'a' }))).rejects.toBe(other);
  });
});

describe('mysql flavor detection', () => {
  it('reads MariaDB out of the version string', async () => {
    const pool = fakePool([[{ version: '11.4.2-MariaDB-ubu2404' }]]);
    const connection = MysqlConnection.forPool(pool, false);
    expect(await connection.detectFlavor()).toBe('mariadb');
  });

  it('reads MySQL out of the version string', async () => {
    const pool = fakePool([[{ version: '8.4.0' }]]);
    const connection = MysqlConnection.forPool(pool, false);
    expect(await connection.detectFlavor()).toBe('mysql');
  });

  it('falls back to mysql when the probe fails, rather than refusing to connect', async () => {
    const pool: MysqlPoolLike = {
      async query() {
        throw new Error('permission denied');
      },
      getConnection: () => Promise.reject(new Error('nope')),
      end: () => Promise.resolve(),
    };
    const connection = MysqlConnection.forPool(pool, false);
    expect(await connection.detectFlavor()).toBe('mysql');
  });

  it('reuses one connection object per pool, so two repos can share a transaction', () => {
    const pool = fakePool();
    expect(MysqlConnection.forPool(pool, false)).toBe(MysqlConnection.forPool(pool, false));
  });

  it('refuses connection options that are not an open pool', () => {
    expect(
      () =>
        new MysqlRepo<Row>({
          table: 'widgets',
          schema,
          connection: { connectionString: 'mysql://x' },
        }),
    ).toThrow(/needs an open pool/);
  });
});
