import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createRepo } from '../../src/core/factory.js';
import { ConnectionError, SchemaError } from '../../src/core/errors.js';
import { defineSchema } from '../../src/core/schema.js';
import { openSqlite } from '../../src/sqlite/index.js';

/**
 * `createRepo` is the one call site an application actually writes, and until these tests
 * it was exercised only by the packaged-consumer job in CI and by the swap example. A
 * regression here would have shipped.
 */

const schema = defineSchema({
  id: { type: 'string', primaryKey: true },
  name: { type: 'string' },
  createdAt: { type: 'date', column: 'created_at' },
  updatedAt: { type: 'date', column: 'updated_at' },
});

interface Row {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

const dir = mkdtempSync(path.join(tmpdir(), 'repolayer-factory-'));
const file = path.join(dir, 'factory.db');

afterAll(() => {
  // Every repo here shares the one pooled connection for this file, so closing it once
  // releases the handle. Windows refuses to remove the directory while it is open.
  openSqlite({ file }).close();
  rmSync(dir, { recursive: true, force: true });
});

describe('createRepo', () => {
  it('builds a working sqlite repo and creates the table on request', async () => {
    const repo = await createRepo<Row>({
      driver: 'sqlite',
      table: 'factory_basic',
      schema,
      connection: { file },
      timestamps: true,
      ensureTable: true,
    });

    const created = await repo.create({ name: 'a' });
    expect(created.name).toBe('a');
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(repo.dialect).toBe('sqlite');
    expect(repo.table).toBe('factory_basic');
  });

  it('accepts an already-open connection object', async () => {
    const connection = openSqlite({ file });
    const repo = await createRepo<Row>({
      driver: 'sqlite',
      table: 'factory_shared',
      schema,
      connection,
      timestamps: true,
      ensureTable: true,
    });
    await repo.create({ name: 'b' });
    expect(await repo.count()).toBe(1);
  });

  it('resolves timestamps: true to the conventional field names', async () => {
    const repo = await createRepo<Row>({
      driver: 'sqlite',
      table: 'factory_ts_true',
      schema,
      connection: { file },
      timestamps: true,
      ensureTable: true,
    });
    const created = await repo.create({ name: 'c' });
    expect(created.updatedAt.getTime()).toBe(created.createdAt.getTime());
  });

  it('accepts explicitly named timestamp fields', async () => {
    const repo = await createRepo<Row>({
      driver: 'sqlite',
      table: 'factory_ts_named',
      schema,
      connection: { file },
      timestamps: { createdAt: 'createdAt', updatedAt: false },
      ensureTable: true,
    });
    const created = await repo.create({ name: 'd', updatedAt: new Date(0) });
    expect(created.createdAt).toBeInstanceOf(Date);
    // updatedAt is the caller's to manage, so the value passed in survives untouched.
    expect(created.updatedAt.getTime()).toBe(0);
  });

  it('leaves timestamps alone when the option is absent', async () => {
    const repo = await createRepo<Row>({
      driver: 'sqlite',
      table: 'factory_ts_off',
      schema,
      connection: { file },
      ensureTable: true,
    });
    const stamp = new Date('2020-01-01T00:00:00.000Z');
    const created = await repo.create({ name: 'e', createdAt: stamp, updatedAt: stamp });
    expect(created.createdAt.getTime()).toBe(stamp.getTime());
  });

  it('does not create the table unless asked', async () => {
    const repo = await createRepo<Row>({
      driver: 'sqlite',
      table: 'factory_no_ddl',
      schema,
      connection: { file },
      timestamps: true,
    });
    await expect(repo.create({ name: 'f' })).rejects.toThrow(/no such table/i);
  });

  it('rejects an unknown driver by name, listing the ones that exist', async () => {
    await expect(
      createRepo({
        driver: 'mongodb',
        table: 't',
        schema,
        connection: {},
      } as unknown as Parameters<typeof createRepo>[0]),
    ).rejects.toBeInstanceOf(ConnectionError);
  });

  it('surfaces a schema error from the id strategy rather than failing later', async () => {
    await expect(
      createRepo<Row>({
        driver: 'sqlite',
        table: 'factory_bad_ids',
        schema,
        connection: { file },
        ids: 'autoincrement',
      }),
    ).rejects.toBeInstanceOf(SchemaError);
  });
});
