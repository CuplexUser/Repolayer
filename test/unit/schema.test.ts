import { describe, expect, it } from 'vitest';

import { columnFor, defineSchema, type Infer } from '../../src/core/schema.js';
import { SchemaError, QueryError } from '../../src/core/errors.js';
import { fromDb, toDb, rowToEntity } from '../../src/core/serialize.js';
import { openSqlite, SqliteRepo } from '../../src/sqlite/index.js';

describe('defineSchema', () => {
  it('precomputes the field and column lookups both adapters use', () => {
    const schema = defineSchema({
      id: { type: 'string', primaryKey: true },
      createdAt: { type: 'date', column: 'created_at' },
    });

    expect(schema.primaryKey).toBe('id');
    expect(schema.columns).toEqual({ id: 'id', createdAt: 'created_at' });
    expect(schema.fieldsByColumn).toEqual({ id: 'id', created_at: 'createdAt' });
    expect(schema.fieldNames).toEqual(['id', 'createdAt']);
    expect(schema.types['createdAt']).toBe('date');
  });

  it('infers the row type, widening nullable fields to include null', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- used as a type below
    const schema = defineSchema({
      id: { type: 'string', primaryKey: true },
      count: { type: 'integer' },
      note: { type: 'string', nullable: true },
      at: { type: 'date' },
    });
    // Compile-time assertion: this only builds if Infer produced the right shape.
    const row: Infer<typeof schema> = {
      id: 'a',
      count: 1,
      note: null,
      at: new Date(),
    };
    expect(row.note).toBeNull();
  });

  it('rejects a schema with no primary key, or with two', () => {
    expect(() => defineSchema({ a: { type: 'string' } })).toThrow(SchemaError);
    expect(() =>
      defineSchema({
        a: { type: 'string', primaryKey: true },
        b: { type: 'string', primaryKey: true },
      }),
    ).toThrow(SchemaError);
  });

  it('types a binary field as Uint8Array', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- used as a type below
    const schema = defineSchema({
      id: { type: 'string', primaryKey: true },
      digest: { type: 'binary' },
      thumbnail: { type: 'binary', nullable: true },
    });
    const row: Infer<typeof schema> = { id: 'a', digest: new Uint8Array(1), thumbnail: null };
    expect(row.digest).toBeInstanceOf(Uint8Array);
  });

  it('rejects a binary primary key and a binary default', () => {
    expect(() => defineSchema({ id: { type: 'binary', primaryKey: true } })).toThrow(SchemaError);
    expect(() =>
      defineSchema({
        id: { type: 'string', primaryKey: true },
        digest: { type: 'binary', default: new Uint8Array(1) },
      }),
    ).toThrow(/binary and declares a default/);
  });

  it('rejects a nullable primary key and an empty schema', () => {
    expect(() => defineSchema({ a: { type: 'string', primaryKey: true, nullable: true } })).toThrow(
      SchemaError,
    );
    expect(() => defineSchema({})).toThrow(SchemaError);
  });

  it('rejects an unknown field type', () => {
    expect(() => defineSchema({ a: { type: 'uuid' as 'string', primaryKey: true } })).toThrow(
      SchemaError,
    );
  });

  it('rejects two fields mapped to the same column', () => {
    expect(() =>
      defineSchema({
        id: { type: 'string', primaryKey: true },
        a: { type: 'string', column: 'shared' },
        b: { type: 'string', column: 'shared' },
      }),
    ).toThrow(SchemaError);
  });

  it('rejects a column name that is not a plain identifier', () => {
    // Column names reach SQL as identifiers, which cannot be parameterized, so they are
    // constrained at definition time instead of escaped at query time.
    expect(() =>
      defineSchema({ id: { type: 'string', primaryKey: true, column: 'a"; DROP TABLE x --' } }),
    ).toThrow(SchemaError);
  });
});

describe('serialization', () => {
  it('stores booleans as 0/1 on sqlite and natively on postgres', () => {
    expect(toDb(true, 'boolean', 'sqlite', 'f')).toBe(1);
    expect(toDb(false, 'boolean', 'sqlite', 'f')).toBe(0);
    expect(toDb(true, 'boolean', 'postgres', 'f')).toBe(true);

    expect(fromDb(1, 'boolean', 'sqlite', 'f')).toBe(true);
    expect(fromDb(0, 'boolean', 'sqlite', 'f')).toBe(false);
    expect(fromDb(false, 'boolean', 'postgres', 'f')).toBe(false);
  });

  it('stores dates as fixed-width ISO text on sqlite, so text ordering is chronological', () => {
    const early = toDb(new Date('2009-12-31T23:59:59.999Z'), 'date', 'sqlite', 'f') as string;
    const late = toDb(new Date('2010-01-01T00:00:00.000Z'), 'date', 'sqlite', 'f') as string;
    expect(early.length).toBe(late.length);
    expect(early < late).toBe(true);
    expect(toDb(new Date(0), 'date', 'postgres', 'f')).toBeInstanceOf(Date);
  });

  it('parses json back on sqlite but leaves the postgres driver result alone', () => {
    // pg already parses jsonb. Parsing again would corrupt a stored string value.
    expect(toDb({ a: 1 }, 'json', 'sqlite', 'f')).toBe('{"a":1}');
    expect(fromDb('{"a":1}', 'json', 'sqlite', 'f')).toEqual({ a: 1 });
    expect(fromDb('plain', 'json', 'postgres', 'f')).toBe('plain');
  });

  it('widens postgres BIGINT strings and sqlite bigints back to numbers', () => {
    expect(fromDb('42', 'integer', 'postgres', 'f')).toBe(42);
    expect(fromDb(42n, 'integer', 'sqlite', 'f')).toBe(42);
  });

  it('refuses to silently lose precision on an unsafe integer', () => {
    expect(() => fromDb('9007199254740993', 'integer', 'postgres', 'f')).toThrow(QueryError);
  });

  it('rejects a value whose type contradicts the schema', () => {
    expect(() => toDb('seven', 'integer', 'sqlite', 'quantity')).toThrow(QueryError);
    expect(() => toDb(1.5, 'integer', 'sqlite', 'quantity')).toThrow(QueryError);
    expect(() => toDb(Number.NaN, 'number', 'sqlite', 'weight')).toThrow(QueryError);
    expect(() => toDb(new Date('nonsense'), 'date', 'sqlite', 'at')).toThrow(QueryError);
    expect(() => toDb(5, 'string', 'sqlite', 'name')).toThrow(QueryError);
  });

  it('binds binary as a Buffer where the driver needs one, keeping a view to its own bytes', () => {
    const backing = Uint8Array.from([9, 1, 2, 3, 9]);
    const view = backing.subarray(1, 4);

    for (const dialect of ['postgres', 'mysql'] as const) {
      const bound = toDb(view, 'binary', dialect, 'f') as Buffer;
      expect(Buffer.isBuffer(bound)).toBe(true);
      expect([...bound]).toEqual([1, 2, 3]);
      // A view over the caller's memory, not a copy.
      expect(bound.buffer).toBe(backing.buffer);
    }
    expect(toDb(view, 'binary', 'sqlite', 'f')).toBe(view);
  });

  it('copies binary into and out of MemoryRepo so the store cannot be reached', () => {
    const input = Buffer.from([1, 2, 3]);
    const stored = toDb(input, 'binary', 'memory', 'f') as Uint8Array;
    input[0] = 99;
    expect([...stored]).toEqual([1, 2, 3]);

    const read = fromDb(stored, 'binary', 'memory', 'f') as Uint8Array;
    read[1] = 99;
    expect([...stored]).toEqual([1, 2, 3]);
  });

  it('reads a driver Buffer back as a plain Uint8Array over the same memory', () => {
    const buffer = Buffer.from([4, 5, 6]);
    const read = fromDb(buffer, 'binary', 'postgres', 'f') as Uint8Array;
    expect(Object.getPrototypeOf(read)).toBe(Uint8Array.prototype);
    expect(read.buffer).toBe(buffer.buffer);
    expect([...read]).toEqual([4, 5, 6]);

    const plain = Uint8Array.from([7]);
    expect(fromDb(plain, 'binary', 'sqlite', 'f')).toBe(plain);
  });

  it('refuses anything but bytes for a binary field, in either direction', () => {
    expect(() => toDb('abc', 'binary', 'sqlite', 'f')).toThrow(QueryError);
    expect(() => toDb([1, 2], 'binary', 'postgres', 'f')).toThrow(/declared binary/);
    expect(() => fromDb('\\x0102', 'binary', 'postgres', 'f')).toThrow(/driver returned/);
    // A typed array that is not bytes is described as such rather than as "a object".
    expect(() => toDb(new Uint8Array(1), 'string', 'sqlite', 'f')).toThrow(/binary data/);
  });

  it('treats null and undefined alike on the way in', () => {
    expect(toDb(null, 'string', 'sqlite', 'f')).toBeNull();
    expect(toDb(undefined, 'date', 'postgres', 'f')).toBeNull();
    expect(fromDb(null, 'json', 'sqlite', 'f')).toBeNull();
  });

  it('maps a result row from column names back to field names', () => {
    const schema = defineSchema({
      id: { type: 'string', primaryKey: true },
      createdAt: { type: 'date', column: 'created_at' },
      active: { type: 'boolean' },
    });
    const entity = rowToEntity<{ id: string; createdAt: Date; active: boolean }>(
      { id: 'x', created_at: '2024-01-01T00:00:00.000Z', active: 1 },
      schema,
      'sqlite',
    );
    expect(entity.id).toBe('x');
    expect(entity.createdAt).toBeInstanceOf(Date);
    expect(entity.active).toBe(true);
  });
});

describe('columnFor', () => {
  const schema = defineSchema({
    id: { type: 'string', primaryKey: true },
    createdAt: { type: 'date', column: 'created_at' },
  });

  it('resolves a field name to its column', () => {
    expect(columnFor(schema, 'createdAt', 'test')).toBe('created_at');
  });

  it('names the context and the known fields when the field is unknown', () => {
    expect(() => columnFor(schema, 'nope', 'orderBy')).toThrow(SchemaError);
    expect(() => columnFor(schema, 'nope', 'orderBy')).toThrow(/orderBy.*id, createdAt/s);
  });
});

describe('sqlite statement cache', () => {
  it('stays bounded, so a varied workload cannot grow it forever', async () => {
    // Every distinct `in` array length compiles to different SQL, so an unbounded cache
    // keyed by SQL text would grow without limit in a long-running process.
    const connection = openSqlite({ file: ':memory:' });
    const repo = new SqliteRepo<{ id: string; name: string }>({
      table: 'cache_probe',
      schema: defineSchema({
        id: { type: 'string', primaryKey: true },
        name: { type: 'string' },
      }),
      connection,
      ids: 'uuid',
    });
    await repo.ensureTable();

    for (let size = 1; size <= 400; size += 1) {
      await repo.findMany({
        where: [{ field: 'id', op: 'in', value: Array.from({ length: size }, (_, i) => `x${i}`) }],
      });
    }

    expect(connection.cachedStatements).toBeLessThanOrEqual(200);
    // Still works after the eviction, which is the part that would break if the cache
    // handed back a statement it had already dropped.
    expect(await repo.findMany({ where: [{ field: 'id', op: 'in', value: ['a'] }] })).toEqual([]);
    connection.close();
  });
});
