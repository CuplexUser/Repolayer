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
  return pool;
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
      await tx
        .withTransaction(async () => {
          throw new Error('inner');
        })
        .catch(() => undefined);
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

describe('postgres cursors', () => {
  /**
   * The Postgres cursor path cannot be proven without a server, and the conformance suite
   * is where that proof lives. What can be checked here is the choreography that makes it
   * safe: the statement order, and above all that the pooled client is released on every
   * exit, including the one where the consumer walks away mid-loop.
   */
  const page = (n: number): Record<string, unknown>[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `id-${i}`,
      email_address: `u${i}@example.com`,
      active: true,
    }));

  async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
    const rows: T[] = [];
    for await (const row of iterable) rows.push(row);
    return rows;
  }

  it('declares a cursor, fetches in batches, then closes and commits', async () => {
    // BEGIN, DECLARE, FETCH (2 rows), FETCH (0 rows), CLOSE, COMMIT
    const pool = fakePool([[], [], page(2), []]);
    const repo = repoOn(pool);

    const rows = await collect(repo.stream(undefined, { batchSize: 2 }));

    expect(rows).toHaveLength(2);
    expect(pool.statements[0]).toBe('BEGIN');
    expect(pool.statements[1]).toContain('NO SCROLL CURSOR FOR SELECT');
    expect(pool.statements[2]).toMatch(/^FETCH FORWARD 2 FROM repolayer_cur_\d+$/);
    expect(pool.statements).toContain('COMMIT');
    expect(pool.statements.some((sql) => sql.startsWith('CLOSE repolayer_cur_'))).toBe(true);
    expect(pool.released).toBe(1);
  });

  it('stops fetching once a short batch says the cursor is drained', async () => {
    // A batch smaller than the requested size can only mean the end, so the extra empty
    // FETCH that would otherwise be needed to discover that is skipped.
    const pool = fakePool([[], [], page(1)]);
    const repo = repoOn(pool);

    await collect(repo.stream(undefined, { batchSize: 10 }));

    expect(pool.statements.filter((sql) => sql.startsWith('FETCH'))).toHaveLength(1);
  });

  it('releases the client and closes the cursor when the consumer breaks early', async () => {
    const pool = fakePool([[], [], page(2), page(2), page(2)]);
    const repo = repoOn(pool);

    for await (const _row of repo.stream(undefined, { batchSize: 2 })) {
      break;
    }

    // The leak this guards against is invisible until the pool is exhausted.
    expect(pool.released).toBe(1);
    expect(pool.statements.some((sql) => sql.startsWith('CLOSE repolayer_cur_'))).toBe(true);
    expect(pool.statements).toContain('COMMIT');
  });

  it('releases the client when the consumer throws inside the loop', async () => {
    const pool = fakePool([[], [], page(2), page(2)]);
    const repo = repoOn(pool);
    const boom = new Error('boom');

    await expect(
      (async () => {
        for await (const _row of repo.stream(undefined, { batchSize: 2 })) throw boom;
      })(),
    ).rejects.toBe(boom);

    expect(pool.released).toBe(1);
  });

  it('rolls back and releases when the engine rejects the DECLARE', async () => {
    const pool = fakePool();
    const failing: PgPoolLike & { released: number } = {
      released: 0,
      query: pool.query.bind(pool),
      async connect() {
        return {
          query: async (sql: string) => {
            if (sql.startsWith('DECLARE')) throw new Error('syntax error');
            return { rows: [] };
          },
          release: () => {
            failing.released += 1;
          },
        };
      },
      end: pool.end.bind(pool),
    };

    const repo = repoOn(failing);
    await expect(collect(repo.stream())).rejects.toThrow('syntax error');
    expect(failing.released).toBe(1);
  });

  it('runs on the transaction connection instead of opening its own', async () => {
    // Inside a transaction there is nothing to BEGIN or COMMIT: doing either would end the
    // caller's transaction out from under them.
    const pool = fakePool([[], [], [], page(1)]);
    const repo = repoOn(pool);

    await repo.withTransaction(async (tx) => {
      await collect(tx.stream(undefined, { batchSize: 5 }));
    });

    const begins = pool.statements.filter((sql) => sql === 'BEGIN');
    const commits = pool.statements.filter((sql) => sql === 'COMMIT');
    expect(begins).toHaveLength(1);
    expect(commits).toHaveLength(1);
    expect(pool.statements.some((sql) => sql.startsWith('CLOSE repolayer_cur_'))).toBe(true);
    expect(pool.released).toBe(1);
  });

  it('never touches the pool when the iterable is not consumed', async () => {
    const pool = fakePool();
    const repo = repoOn(pool);
    repo.stream();
    await Promise.resolve();
    expect(pool.statements).toEqual([]);
    expect(pool.released).toBe(0);
  });
});

describe('postgres verifyTable', () => {
  /** Catalog rows shaped the way information_schema and pg_index actually return them. */
  function catalog(): Record<string, unknown>[][] {
    return [
      [
        { column_name: 'id', data_type: 'text', is_nullable: 'NO', column_default: null },
        {
          column_name: 'email_address',
          data_type: 'text',
          is_nullable: 'NO',
          column_default: null,
        },
        { column_name: 'active', data_type: 'boolean', is_nullable: 'NO', column_default: null },
      ],
      [
        { column_name: 'id', indisprimary: true },
        { column_name: 'email_address', indisprimary: false },
      ],
    ];
  }

  it('reads the catalog and reports a clean table', async () => {
    const pool = fakePool(catalog());
    const diff = await repoOn(pool).verifyTable();

    expect(diff.findings).toEqual([]);
    expect(diff.ok).toBe(true);
    // Lowered on the way in: repolayer never quotes identifiers, so Postgres folded the
    // name when the table was created.
    expect(pool.statements[0]).toContain('table_name = lower($1)');
    // pg_index rather than information_schema, so a bare unique index still counts.
    expect(pool.statements[1]).toContain('pg_index');
    expect(pool.statements[1]).toContain('indnkeyatts = 1');
  });

  it('reports the table missing when the catalog returns no columns', async () => {
    const diff = await repoOn(fakePool([[]])).verifyTable();
    expect(diff.ok).toBe(false);
    expect(diff.findings[0]?.kind).toBe('missingTable');
  });

  it('separates the primary key from the unique columns', async () => {
    const rows = catalog();
    // Drop the unique index on email_address; the schema declares the field unique.
    rows[1] = [{ column_name: 'id', indisprimary: true }];
    const diff = await repoOn(fakePool(rows)).verifyTable();

    expect(diff.findings.find((f) => f.kind === 'missingUnique')?.field).toBe('email');
    expect(diff.findings.find((f) => f.kind === 'primaryKeyMismatch')).toBeUndefined();
  });

  it('flags a jsonb field stored as text, which nothing would parse', async () => {
    const jsonSchema = defineSchema({
      id: { type: 'string', primaryKey: true },
      meta: { type: 'json' },
    });
    const pool = fakePool([
      [
        { column_name: 'id', data_type: 'text', is_nullable: 'NO', column_default: null },
        { column_name: 'meta', data_type: 'text', is_nullable: 'NO', column_default: null },
      ],
      [{ column_name: 'id', indisprimary: true }],
    ]);
    const repo = new PostgresRepo({
      table: 'docs',
      schema: jsonSchema,
      connection: pool,
      ids: 'uuid',
      timestamps: {},
    });

    const diff = await repo.verifyTable();
    expect(diff.ok).toBe(false);
    expect(diff.findings.find((f) => f.kind === 'typeIncompatible')?.field).toBe('meta');
  });
});
