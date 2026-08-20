import { describe, expect, it } from 'vitest';

import { PostgresConnection, PostgresRepo, type PgPoolLike } from '../../src/postgres/index.js';
import { defineSchema } from '../../src/core/schema.js';
import { ConnectionError, NotFoundError, UniqueConstraintError } from '../../src/core/errors.js';

/**
 * Postgres adapter behavior that does not need a live server.
 *
 * The conformance suite is the real proof and needs a database, but everything here
 * (driver loading, error translation, transaction choreography, the SQL actually issued)
 * can be checked without one, and these run on every `npm test`.
 */

const schema = defineSchema({
  id: { type: 'string', primaryKey: true },
  email: { type: 'string', unique: true, column: 'email_address' },
  active: { type: 'boolean' },
});

interface User {
  id: string;
  email: string;
  active: boolean;
}

/** Records every statement issued, and replays canned results. */
function fakePool(results: Record<string, unknown>[][] = []): PgPoolLike & {
  statements: string[];
  released: number;
} {
  const statements: string[] = [];
  const queue = [...results];
  const run = async (sql: string): Promise<{ rows: Record<string, unknown>[] }> => {
    statements.push(sql);
    return { rows: queue.shift() ?? [] };
  };
  const pool = {
    statements,
    released: 0,
    async query(sql: string) {
      return run(sql);
    },
    async connect() {
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
  return pool as PgPoolLike & { statements: string[]; released: number };
}

function repoOn(pool: PgPoolLike): PostgresRepo<User> {
  return new PostgresRepo<User>({
    table: 'users',
    schema,
    connection: pool,
    ids: 'uuid',
    timestamps: {},
  });
}

describe('postgres driver loading', () => {
  it('loads pg lazily and builds a pool without opening a connection', async () => {
    const connection = await PostgresConnection.create({
      connectionString: 'postgres://user:pass@127.0.0.1:1/nothing',
    });
    expect(typeof connection.pool.connect).toBe('function');
    expect(typeof connection.pool.query).toBe('function');
    await connection.end();
  });

  it('refuses a bare connection config, since opening a pool is asynchronous', () => {
    expect(
      () =>
        new PostgresRepo<User>({
          table: 'users',
          schema,
          connection: { connectionString: 'postgres://x' },
        }),
    ).toThrow(ConnectionError);
  });
});

describe('postgres error translation', () => {
  it('turns SQLSTATE 23505 into UniqueConstraintError naming the schema field', async () => {
    const pool = fakePool();
    pool.query = async () => {
      throw Object.assign(new Error('duplicate key'), {
        code: '23505',
        detail: 'Key (email_address)=(a@b.c) already exists.',
      });
    };
    const repo = repoOn(pool);

    const error = await repo.create({ email: 'a@b.c', active: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UniqueConstraintError);
    // The driver reports a column; the caller gets the field name they wrote.
    expect((error as UniqueConstraintError).fields).toEqual(['email']);
  });

  it('passes other driver errors through unchanged', async () => {
    const pool = fakePool();
    const original = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    pool.query = async () => {
      throw original;
    };
    await expect(repoOn(pool).findMany()).rejects.toBe(original);
  });

  it('reports a missing row as NotFoundError on update and delete', async () => {
    const repo = repoOn(fakePool());
    await expect(repo.update('nope', { active: true })).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.delete('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('postgres statement generation', () => {
  it('issues $n placeholders and RETURNING on insert', async () => {
    const pool = fakePool([[{ id: 'x', email_address: 'a@b.c', active: true }]]);
    await repoOn(pool).create({ email: 'a@b.c', active: true });

    const [sql] = pool.statements;
    expect(sql).toContain('INSERT INTO users (id, email_address, active)');
    expect(sql).toContain('VALUES ($1, $2, $3)');
    expect(sql).toContain('RETURNING id, email_address, active');
  });

  it('maps result columns back onto schema field names', async () => {
    const pool = fakePool([[{ id: 'x', email_address: 'a@b.c', active: true }]]);
    const row = await repoOn(pool).findById('x');
    expect(row).toEqual({ id: 'x', email: 'a@b.c', active: true });
  });

  it('reads COUNT(*) even though pg returns BIGINT as a string', async () => {
    const pool = fakePool([[{ count: '7' }]]);
    expect(await repoOn(pool).count()).toBe(7);
  });
});

describe('postgres transactions', () => {
  it('runs BEGIN and COMMIT on one checked-out client, then releases it', async () => {
    const pool = fakePool([[], [{ id: 'x', email_address: 'a@b.c', active: true }], []]);
    const repo = repoOn(pool);

    await repo.withTransaction(async (tx) => {
      await tx.create({ email: 'a@b.c', active: true });
    });

    expect(pool.statements[0]).toBe('BEGIN');
    expect(pool.statements.at(-1)).toBe('COMMIT');
    expect(pool.released).toBe(1);
  });

  it('rolls back and still releases the client when the callback throws', async () => {
    const pool = fakePool();
    const repo = repoOn(pool);

    await expect(
      repo.withTransaction(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(pool.statements).toContain('ROLLBACK');
    // A leaked client permanently shrinks the pool, so this assertion matters more than
    // it looks: without it a failing transaction would slowly deadlock the process.
    expect(pool.released).toBe(1);
  });

  it('uses savepoints for a nested transaction rather than a second BEGIN', async () => {
    const pool = fakePool();
    const repo = repoOn(pool);

    await repo.withTransaction(async (tx) => {
      await tx.withTransaction(async () => undefined);
    });

    expect(pool.statements).toEqual([
      'BEGIN',
      'SAVEPOINT repolayer_sp_1',
      'RELEASE SAVEPOINT repolayer_sp_1',
      'COMMIT',
    ]);
    expect(pool.released).toBe(1);
  });

  it('rolls back to the savepoint without abandoning the outer transaction', async () => {
    const pool = fakePool();
    const repo = repoOn(pool);

    await repo.withTransaction(async (tx) => {
      await tx.withTransaction(async () => {
        throw new Error('inner');
      }).catch(() => undefined);
    });

    expect(pool.statements).toContain('ROLLBACK TO SAVEPOINT repolayer_sp_1');
    expect(pool.statements).not.toContain('ROLLBACK');
    expect(pool.statements.at(-1)).toBe('COMMIT');
  });

  it('refuses to bind a repo from a different connection to a transaction', async () => {
    const repoA = repoOn(fakePool());
    const repoB = repoOn(fakePool());

    await expect(
      repoA.withTransaction(async (_tx, ctx) => {
        repoB.with(ctx);
      }),
    ).rejects.toThrow(/different connection/);
  });

  it('lets a repo on the same pool join the transaction', async () => {
    const pool = fakePool();
    const repoA = repoOn(pool);
    const repoB = repoOn(pool);

    await repoA.withTransaction(async (_tx, ctx) => {
      expect(() => repoB.with(ctx)).not.toThrow();
    });
  });
});
