import { describe, expect, it, afterAll } from 'vitest';

import { defineSchema, type Schema } from '../core/schema.js';
export { MemoryRepo, MemoryStore, createMemoryRepo } from './memory.js';
export type { MemoryRepoOptions } from './memory.js';
import { NotFoundError, QueryError, UniqueConstraintError } from '../core/errors.js';
import type { Filter, QueryOptions } from '../core/query.js';
import type { Repo, TxContext } from '../core/repo.js';

/**
 * The shared conformance suite: the contract every adapter must satisfy.
 *
 * Both first-party adapters run exactly this file, which is what turns "the two backends
 * behave identically" from a hope into something checked on every commit. It is exported
 * as `repolayer/testing` so a third-party adapter can prove itself the same way.
 */

/** The model the suite exercises. Covers every field type and both nullability cases. */
export const widgetSchema = defineSchema({
  id: { type: 'string', primaryKey: true },
  name: { type: 'string' },
  slug: { type: 'string', unique: true },
  quantity: { type: 'integer' },
  weight: { type: 'number' },
  active: { type: 'boolean' },
  meta: { type: 'json', nullable: true },
  releasedAt: { type: 'date', nullable: true, column: 'released_at' },
  createdAt: { type: 'date', column: 'created_at' },
  updatedAt: { type: 'date', column: 'updated_at' },
});

export interface Widget {
  id: string;
  name: string;
  slug: string;
  quantity: number;
  weight: number;
  active: boolean;
  meta: unknown | null;
  releasedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A second model, used to prove two repos can share one transaction. */
export const noteSchema = defineSchema({
  id: { type: 'string', primaryKey: true },
  body: { type: 'string' },
});

export interface Note {
  id: string;
  body: string;
}

/** Capability groups an adapter may declare unsupported, with a stated reason. */
export type ConformanceCapability = 'transactions' | 'autoincrement';

/** What the suite asks an adapter to build. Exported so adapters can annotate it. */
export interface ConformanceRepoOptions {
  schema: Schema;
  table: string;
  ids?: 'uuid' | 'autoincrement' | 'provided';
  timestamps?: boolean;
}

export interface ConformanceAdapter {
  /** Shown in test output, e.g. 'sqlite'. */
  name: string;
  /**
   * Creates a repo over a fresh, isolated table. Called once per test, so the suite never
   * depends on the order tests run in.
   */
  createRepo<T>(options: ConformanceRepoOptions): Promise<Repo<T>>;
  /** Runs once after the whole suite. */
  cleanup?(): Promise<void>;
  /**
   * Capabilities this engine genuinely cannot provide, each with a reason. Declaring one
   * is a deliberate, visible statement, not a quiet skip: an adapter that simply fails
   * these tests is broken, while one that declares them is documented.
   */
  unsupported?: Partial<Record<ConformanceCapability, string>>;
  /**
   * How many connections are checked out right now, when the engine has a pool.
   *
   * When provided, the cursor cases assert it returns to its baseline after a consumer
   * leaves a stream early. A leaked connection is invisible until the pool is exhausted,
   * at which point the process deadlocks with no clue as to why.
   */
  busyConnections?(): number;
}

let tableCounter = 0;
// A per-process random tag, not just the pid: under a thread-based vitest pool every worker
// shares one pid, and two CI jobs can point at the same server. A collision would surface as
// an unrelated test failing intermittently, which is the worst kind to chase.
const tableTag = Math.random().toString(36).slice(2, 8);
function uniqueTable(prefix: string): string {
  tableCounter += 1;
  return `${prefix}_${tableTag}_${tableCounter}`;
}

/**
 * Drains an async iterable. Written out rather than using `Array.fromAsync`, so the suite
 * keeps working for consumers whose TypeScript lib target predates ES2024.
 */
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const rows: T[] = [];
  for await (const row of iterable) rows.push(row);
  return rows;
}

const baseWidget = (overrides: Partial<Widget> = {}): Partial<Widget> => ({
  name: 'Anvil',
  slug: `slug-${Math.random().toString(36).slice(2, 10)}`,
  quantity: 3,
  weight: 1.5,
  active: true,
  meta: null,
  releasedAt: null,
  ...overrides,
});

export function runConformanceSuite(adapter: ConformanceAdapter): void {
  const unsupported = adapter.unsupported ?? {};

  describe(`conformance: ${adapter.name}`, () => {
    afterAll(async () => {
      await adapter.cleanup?.();
    });

    /** Fresh repo per test, with the table already created. */
    async function widgets(
      options: { ids?: 'uuid' | 'autoincrement' | 'provided'; timestamps?: boolean } = {},
    ): Promise<Repo<Widget>> {
      return adapter.createRepo<Widget>({
        schema: widgetSchema,
        table: uniqueTable('widgets'),
        ids: options.ids ?? 'uuid',
        timestamps: options.timestamps ?? true,
      });
    }

    // ------------------------------------------------------------------ CRUD

    describe('crud', () => {
      it('creates, reads, updates, and deletes a row', async () => {
        const repo = await widgets();
        const created = await repo.create(baseWidget({ name: 'Anvil' }));

        expect(created.id).toBeTypeOf('string');
        expect(created.name).toBe('Anvil');

        const found = await repo.findById(created.id);
        expect(found).toEqual(created);

        const updated = await repo.update(created.id, { name: 'Hammer' });
        expect(updated.name).toBe('Hammer');
        expect(updated.id).toBe(created.id);

        await repo.delete(created.id);
        expect(await repo.findById(created.id)).toBeNull();
      });

      it('returns null rather than throwing for a missing id', async () => {
        const repo = await widgets();
        expect(await repo.findById('does-not-exist')).toBeNull();
      });

      it('throws NotFoundError when updating a missing row', async () => {
        const repo = await widgets();
        await expect(repo.update('missing', { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
      });

      it('throws NotFoundError when deleting a missing row', async () => {
        const repo = await widgets();
        await expect(repo.delete('missing')).rejects.toBeInstanceOf(NotFoundError);
      });

      it('applies a partial update without disturbing other fields', async () => {
        const repo = await widgets();
        const created = await repo.create(baseWidget({ name: 'A', quantity: 7, weight: 2.5 }));
        const updated = await repo.update(created.id, { quantity: 9 });

        expect(updated.quantity).toBe(9);
        expect(updated.name).toBe('A');
        expect(updated.weight).toBe(2.5);
      });

      it('creates many rows in one call', async () => {
        const repo = await widgets();
        const created = await repo.createMany([
          baseWidget({ name: 'A' }),
          baseWidget({ name: 'B' }),
          baseWidget({ name: 'C' }),
        ]);
        expect(created).toHaveLength(3);
        expect(new Set(created.map((w) => w.id)).size).toBe(3);
        expect(await repo.count()).toBe(3);
      });

      it('deletes many rows by filter and reports how many went', async () => {
        const repo = await widgets();
        await repo.createMany([
          baseWidget({ active: true }),
          baseWidget({ active: true }),
          baseWidget({ active: false }),
        ]);

        const removed = await repo.deleteMany({
          where: [{ field: 'active', op: 'eq', value: true }],
        });
        expect(removed).toBe(2);
        expect(await repo.count()).toBe(1);

        expect(await repo.deleteMany()).toBe(1);
        expect(await repo.count()).toBe(0);
      });

      it('treats createMany([]) as a no-op', async () => {
        const repo = await widgets();
        expect(await repo.createMany([])).toEqual([]);
        expect(await repo.count()).toBe(0);
      });
    });

    // ---------------------------------------------------------------- updateMany

    describe('updateMany', () => {
      async function seeded(): Promise<Repo<Widget>> {
        const repo = await widgets();
        await repo.createMany([
          baseWidget({ slug: 'a', quantity: 1, active: true }),
          baseWidget({ slug: 'b', quantity: 5, active: true }),
          baseWidget({ slug: 'c', quantity: 9, active: false }),
        ]);
        return repo;
      }

      it('updates every matching row and reports how many matched', async () => {
        const repo = await seeded();
        const changed = await repo.updateMany(
          { where: [{ field: 'active', op: 'eq', value: true }] },
          { name: 'renamed' },
        );

        expect(changed).toBe(2);
        const names = (await repo.findMany({ orderBy: [{ field: 'slug', direction: 'asc' }] })).map(
          (r) => r.name,
        );
        expect(names).toEqual(['renamed', 'renamed', 'Anvil']);
      });

      it('updates every row when no filter is given, matching deleteMany', async () => {
        const repo = await seeded();
        expect(await repo.updateMany(undefined, { active: false })).toBe(3);
        expect(await repo.count({ where: { active: false } })).toBe(3);
      });

      it('reports zero and changes nothing when the filter matches nothing', async () => {
        const repo = await seeded();
        expect(await repo.updateMany({ where: { slug: 'nope' } }, { name: 'x' })).toBe(0);
        expect(await repo.count({ where: [{ field: 'name', op: 'eq', value: 'x' }] })).toBe(0);
      });

      it('counts rows matched, not rows whose value actually changed', async () => {
        // Otherwise the number would depend on the data rather than on the filter, and the
        // engines would disagree: MySQL reports changed rows by default where the others
        // report matched.
        const repo = await seeded();
        await repo.updateMany(undefined, { name: 'same' });
        expect(await repo.updateMany(undefined, { name: 'same' })).toBe(3);
      });

      it('advances updatedAt but leaves createdAt alone', async () => {
        const repo = await seeded();
        const before = await repo.findMany({ orderBy: [{ field: 'slug', direction: 'asc' }] });
        await new Promise((resolve) => setTimeout(resolve, 5));

        await repo.updateMany(undefined, { name: 'stamped' });
        const after = await repo.findMany({ orderBy: [{ field: 'slug', direction: 'asc' }] });

        for (const [index, row] of after.entries()) {
          const original = before[index] as Widget;
          expect(row.createdAt.getTime()).toBe(original.createdAt.getTime());
          expect(row.updatedAt.getTime()).toBeGreaterThan(original.updatedAt.getTime());
        }
      });

      it('never moves the primary key, even when one is passed', async () => {
        const repo = await seeded();
        const ids = (await repo.findMany()).map((r) => r.id).sort();
        await repo.updateMany(undefined, { id: 'hijacked' });
        expect((await repo.findMany()).map((r) => r.id).sort()).toEqual(ids);
      });

      it('works through a filter tree', async () => {
        const repo = await seeded();
        const changed = await repo.updateMany(
          {
            where: [
              {
                or: [
                  { field: 'slug', op: 'eq', value: 'a' },
                  { field: 'quantity', op: 'gte', value: 9 },
                ],
              },
            ],
          },
          { weight: 9.5 },
        );
        expect(changed).toBe(2);
        expect(await repo.count({ where: [{ field: 'weight', op: 'eq', value: 9.5 }] })).toBe(2);
      });

      it('rejects an unknown field before touching the database', async () => {
        const repo = await seeded();
        await expect(
          repo.updateMany(undefined, { bogus: 1 } as Partial<Widget>),
        ).rejects.toBeInstanceOf(QueryError);
      });

      it('reports the matched count when there is nothing to set', async () => {
        // Timestamps off, so an empty change really is empty. With them on there is always
        // an updatedAt to write, which is a different path.
        const repo = await widgets({ timestamps: false });
        const stamp = new Date('2024-01-01T00:00:00.000Z');
        await repo.createMany([
          baseWidget({ slug: 'x', createdAt: stamp, updatedAt: stamp }),
          baseWidget({ slug: 'y', createdAt: stamp, updatedAt: stamp }),
        ]);
        expect(await repo.updateMany(undefined, {})).toBe(2);
        expect((await repo.findOne())?.updatedAt.getTime()).toBe(stamp.getTime());
      });

      it('rolls back with its transaction', async () => {
        const repo = await seeded();
        await repo
          .withTransaction(async (tx) => {
            await tx.updateMany(undefined, { name: 'ghost' });
            throw new Error('nope');
          })
          .catch(() => undefined);
        expect(await repo.count({ where: [{ field: 'name', op: 'eq', value: 'ghost' }] })).toBe(0);
      });
    });

    // ------------------------------------------------------- type round trips

    describe('type round trips', () => {
      it('round trips booleans as booleans', async () => {
        const repo = await widgets();
        const on = await repo.create(baseWidget({ active: true }));
        const off = await repo.create(baseWidget({ active: false }));

        expect(on.active).toBe(true);
        expect(off.active).toBe(false);
        expect((await repo.findById(off.id))?.active).toBe(false);
      });

      it('round trips dates as Date objects, preserving milliseconds and UTC', async () => {
        const repo = await widgets();
        const released = new Date('2024-03-05T06:07:08.123Z');
        const created = await repo.create(baseWidget({ releasedAt: released }));

        expect(created.releasedAt).toBeInstanceOf(Date);
        expect(created.releasedAt?.toISOString()).toBe(released.toISOString());
        expect((await repo.findById(created.id))?.releasedAt?.getTime()).toBe(released.getTime());
      });

      it('round trips nested json, including arrays and embedded nulls', async () => {
        const repo = await widgets();
        const meta = { tags: ['a', 'b'], nested: { n: 1, missing: null }, list: [1, 2, 3] };
        const created = await repo.create(baseWidget({ meta }));

        expect(created.meta).toEqual(meta);
        expect((await repo.findById(created.id))?.meta).toEqual(meta);
      });

      it('round trips a json value that is itself a string', async () => {
        // The tempting shortcut of JSON.parse-ing every result would corrupt this one.
        const repo = await widgets();
        const created = await repo.create(baseWidget({ meta: 'plain string' }));
        expect((await repo.findById(created.id))?.meta).toBe('plain string');
      });

      it('distinguishes null from absent for a nullable field', async () => {
        const repo = await widgets();
        const created = await repo.create(baseWidget({ releasedAt: null, meta: null }));
        expect(created.releasedAt).toBeNull();
        expect(created.meta).toBeNull();
      });

      it('round trips empty strings, zero, and negative numbers', async () => {
        const repo = await widgets();
        const created = await repo.create(
          baseWidget({ name: '', quantity: 0, weight: -2.25, active: false }),
        );
        const found = await repo.findById(created.id);

        expect(found?.name).toBe('');
        expect(found?.quantity).toBe(0);
        expect(found?.weight).toBe(-2.25);
      });

      it('round trips large integers up to the safe range', async () => {
        const repo = await widgets();
        const created = await repo.create(baseWidget({ quantity: Number.MAX_SAFE_INTEGER }));
        expect((await repo.findById(created.id))?.quantity).toBe(Number.MAX_SAFE_INTEGER);
      });

      it('rejects a value whose type does not match the schema', async () => {
        const repo = await widgets();
        await expect(
          repo.create(baseWidget({ quantity: 'seven' as unknown as number })),
        ).rejects.toBeInstanceOf(QueryError);
      });
    });

    // ------------------------------------------------------------------ filters

    describe('filters', () => {
      async function seeded(): Promise<Repo<Widget>> {
        const repo = await widgets();
        await repo.createMany([
          baseWidget({ name: 'Anvil', slug: 'a', quantity: 1, active: true }),
          baseWidget({ name: 'anvil', slug: 'b', quantity: 5, active: false }),
          baseWidget({ name: 'Barrel', slug: 'c', quantity: 10, active: true }),
          baseWidget({ name: 'Crate', slug: 'd', quantity: 10, active: false, meta: { x: 1 } }),
        ]);
        return repo;
      }

      it('supports the object form of where as an implicit AND of equality', async () => {
        const repo = await seeded();
        const rows = await repo.findMany({ where: { quantity: 10, active: true } });
        expect(rows.map((r) => r.name)).toEqual(['Barrel']);
      });

      it('supports eq, ne, gt, gte, lt, lte', async () => {
        const repo = await seeded();
        const names = async (filter: Parameters<typeof repo.findMany>[0]): Promise<string[]> =>
          (await repo.findMany(filter)).map((r) => r.slug).sort();

        expect(await names({ where: [{ field: 'quantity', op: 'eq', value: 10 }] })).toEqual([
          'c',
          'd',
        ]);
        expect(await names({ where: [{ field: 'quantity', op: 'ne', value: 10 }] })).toEqual([
          'a',
          'b',
        ]);
        expect(await names({ where: [{ field: 'quantity', op: 'gt', value: 5 }] })).toEqual([
          'c',
          'd',
        ]);
        expect(await names({ where: [{ field: 'quantity', op: 'gte', value: 5 }] })).toEqual([
          'b',
          'c',
          'd',
        ]);
        expect(await names({ where: [{ field: 'quantity', op: 'lt', value: 5 }] })).toEqual(['a']);
        expect(await names({ where: [{ field: 'quantity', op: 'lte', value: 5 }] })).toEqual([
          'a',
          'b',
        ]);
      });

      it('ANDs multiple filters together', async () => {
        const repo = await seeded();
        const rows = await repo.findMany({
          where: [
            { field: 'quantity', op: 'gte', value: 5 },
            { field: 'active', op: 'eq', value: false },
          ],
        });
        expect(rows.map((r) => r.slug).sort()).toEqual(['b', 'd']);
      });

      it('supports in and nin', async () => {
        const repo = await seeded();
        const inRows = await repo.findMany({
          where: [{ field: 'slug', op: 'in', value: ['a', 'c'] }],
        });
        expect(inRows.map((r) => r.slug).sort()).toEqual(['a', 'c']);

        const ninRows = await repo.findMany({
          where: [{ field: 'slug', op: 'nin', value: ['a', 'c'] }],
        });
        expect(ninRows.map((r) => r.slug).sort()).toEqual(['b', 'd']);
      });

      it('treats an empty in as matching nothing and an empty nin as matching everything', async () => {
        const repo = await seeded();
        expect(await repo.findMany({ where: [{ field: 'slug', op: 'in', value: [] }] })).toEqual(
          [],
        );
        expect(
          (await repo.findMany({ where: [{ field: 'slug', op: 'nin', value: [] }] })).length,
        ).toBe(4);
      });

      it('keeps null rows in a ne result', async () => {
        // Raw SQL would drop them, since NULL <> 'x' is NULL rather than true.
        const repo = await seeded();
        const rows = await repo.findMany({
          where: [{ field: 'meta', op: 'ne', value: { x: 2 } }],
        });
        expect(rows.length).toBe(4);
      });

      it('supports isNull in both directions', async () => {
        const repo = await seeded();
        const nulls = await repo.findMany({ where: [{ field: 'meta', op: 'isNull' }] });
        expect(nulls.map((r) => r.slug).sort()).toEqual(['a', 'b', 'c']);

        const notNull = await repo.findMany({
          where: [{ field: 'meta', op: 'isNull', value: false }],
        });
        expect(notNull.map((r) => r.slug)).toEqual(['d']);
      });

      it('makes like case sensitive on every engine', async () => {
        const repo = await seeded();
        const rows = await repo.findMany({ where: [{ field: 'name', op: 'like', value: 'A%' }] });
        expect(rows.map((r) => r.slug)).toEqual(['a']);
      });

      it('makes ilike case insensitive on every engine', async () => {
        const repo = await seeded();
        const rows = await repo.findMany({ where: [{ field: 'name', op: 'ilike', value: 'a%' }] });
        expect(rows.map((r) => r.slug).sort()).toEqual(['a', 'b']);
      });

      it('treats an underscore in a like pattern as a single-character wildcard', async () => {
        const repo = await widgets();
        await repo.createMany([
          baseWidget({ name: 'ab', slug: 'p' }),
          baseWidget({ name: 'axb', slug: 'q' }),
          baseWidget({ name: 'axxb', slug: 'r' }),
        ]);
        const rows = await repo.findMany({ where: [{ field: 'name', op: 'like', value: 'a_b' }] });
        expect(rows.map((r) => r.slug)).toEqual(['q']);
      });

      it('rejects a non-array value for in', async () => {
        const repo = await widgets();
        await expect(
          repo.findMany({ where: [{ field: 'slug', op: 'in', value: 'a' }] }),
        ).rejects.toBeInstanceOf(QueryError);
      });
    });

    // ------------------------------------------------------------- filter trees

    describe('filter trees', () => {
      async function seeded(): Promise<Repo<Widget>> {
        const repo = await widgets();
        await repo.createMany([
          baseWidget({ name: 'Anvil', slug: 'a', quantity: 1, active: true }),
          baseWidget({ name: 'anvil', slug: 'b', quantity: 5, active: false }),
          baseWidget({ name: 'Barrel', slug: 'c', quantity: 10, active: true }),
          baseWidget({ name: 'Crate', slug: 'd', quantity: 10, active: false, meta: { x: 1 } }),
        ]);
        return repo;
      }

      it('matches any branch of an or group', async () => {
        const repo = await seeded();
        const rows = await repo.findMany({
          where: [
            {
              or: [
                { field: 'slug', op: 'eq', value: 'a' },
                { field: 'quantity', op: 'gte', value: 10 },
              ],
            },
          ],
        });
        expect(rows.map((r) => r.slug).sort()).toEqual(['a', 'c', 'd']);
      });

      it('ANDs a top level filter with an or group rather than flattening them', async () => {
        // The case that proves the group is parenthesized. Without the parentheses this
        // would read as (active AND slug=a) OR quantity>=10 and return three rows.
        const repo = await seeded();
        const rows = await repo.findMany({
          where: [
            { field: 'active', op: 'eq', value: true },
            {
              or: [
                { field: 'slug', op: 'eq', value: 'a' },
                { field: 'quantity', op: 'gte', value: 10 },
              ],
            },
          ],
        });
        expect(rows.map((r) => r.slug).sort()).toEqual(['a', 'c']);
      });

      it('nests an and group inside an or group', async () => {
        const repo = await seeded();
        const rows = await repo.findMany({
          where: [
            {
              or: [
                {
                  and: [
                    { field: 'active', op: 'eq', value: false },
                    { field: 'quantity', op: 'lte', value: 5 },
                  ],
                },
                { field: 'slug', op: 'eq', value: 'c' },
              ],
            },
          ],
        });
        expect(rows.map((r) => r.slug).sort()).toEqual(['b', 'c']);
      });

      it('keeps null rows in an or branch that uses ne', async () => {
        // `ne` preserves nulls on its own; putting it in a group must not change that.
        const repo = await seeded();
        const rows = await repo.findMany({
          where: [
            {
              or: [
                { field: 'meta', op: 'ne', value: { x: 1 } },
                { field: 'slug', op: 'eq', value: 'zzz' },
              ],
            },
          ],
        });
        expect(rows.map((r) => r.slug).sort()).toEqual(['a', 'b', 'c']);
      });

      it('treats an empty or as matching nothing and an empty and as matching everything', async () => {
        const repo = await seeded();
        expect(await repo.findMany({ where: [{ or: [] }] })).toEqual([]);
        expect((await repo.findMany({ where: [{ and: [] }] })).length).toBe(4);
      });

      it('counts and deletes through a filter tree, agreeing with findMany', async () => {
        const repo = await seeded();
        const tree = {
          where: [
            {
              or: [
                { field: 'slug' as const, op: 'eq' as const, value: 'a' },
                { field: 'slug' as const, op: 'eq' as const, value: 'b' },
              ],
            },
          ],
        };
        expect(await repo.count(tree)).toBe(2);
        expect(await repo.deleteMany(tree)).toBe(2);
        expect(await repo.count()).toBe(2);
      });

      it('rejects a tree nested past the depth limit', async () => {
        const repo = await widgets();
        let node: Filter<Widget> = { field: 'slug', op: 'eq', value: 'a' };
        for (let i = 0; i < 20; i += 1) node = { and: [node] };
        await expect(repo.findMany({ where: [node] })).rejects.toBeInstanceOf(QueryError);
      });
    });

    // --------------------------------------------------------- ordering, paging

    describe('ordering and paging', () => {
      async function ordered(): Promise<Repo<Widget>> {
        const repo = await widgets();
        await repo.createMany([
          baseWidget({ slug: 'a', quantity: 2, name: 'x' }),
          baseWidget({ slug: 'b', quantity: 1, name: 'y' }),
          baseWidget({ slug: 'c', quantity: 2, name: 'a' }),
          baseWidget({ slug: 'd', quantity: 3, name: 'z' }),
        ]);
        return repo;
      }

      it('orders by a single key in both directions', async () => {
        const repo = await ordered();
        const asc = await repo.findMany({ orderBy: [{ field: 'slug', direction: 'asc' }] });
        expect(asc.map((r) => r.slug)).toEqual(['a', 'b', 'c', 'd']);

        const desc = await repo.findMany({ orderBy: [{ field: 'slug', direction: 'desc' }] });
        expect(desc.map((r) => r.slug)).toEqual(['d', 'c', 'b', 'a']);
      });

      it('orders by multiple keys in order of precedence', async () => {
        const repo = await ordered();
        const rows = await repo.findMany({
          orderBy: [
            { field: 'quantity', direction: 'asc' },
            { field: 'name', direction: 'asc' },
          ],
        });
        expect(rows.map((r) => r.slug)).toEqual(['b', 'c', 'a', 'd']);
      });

      it('places nulls last on asc and first on desc, identically on every engine', async () => {
        // Left to their defaults the engines disagree here, so this is the case that
        // actually proves the normalization is doing something.
        const repo = await widgets();
        await repo.createMany([
          baseWidget({ slug: 'has-1', releasedAt: new Date('2024-01-01T00:00:00.000Z') }),
          baseWidget({ slug: 'null-1', releasedAt: null }),
          baseWidget({ slug: 'has-2', releasedAt: new Date('2023-01-01T00:00:00.000Z') }),
          baseWidget({ slug: 'null-2', releasedAt: null }),
        ]);

        const asc = await repo.findMany({ orderBy: [{ field: 'releasedAt', direction: 'asc' }] });
        expect(asc.slice(0, 2).map((r) => r.slug)).toEqual(['has-2', 'has-1']);
        expect(asc.slice(2).every((r) => r.releasedAt === null)).toBe(true);

        const desc = await repo.findMany({
          orderBy: [{ field: 'releasedAt', direction: 'desc' }],
        });
        expect(desc.slice(0, 2).every((r) => r.releasedAt === null)).toBe(true);
        expect(desc.slice(2).map((r) => r.slug)).toEqual(['has-1', 'has-2']);
      });

      it('supports limit, offset, and offset without limit', async () => {
        const repo = await ordered();
        const order = [{ field: 'slug' as const, direction: 'asc' as const }];

        expect((await repo.findMany({ orderBy: order, limit: 2 })).map((r) => r.slug)).toEqual([
          'a',
          'b',
        ]);
        expect(
          (await repo.findMany({ orderBy: order, limit: 2, offset: 1 })).map((r) => r.slug),
        ).toEqual(['b', 'c']);
        expect((await repo.findMany({ orderBy: order, offset: 2 })).map((r) => r.slug)).toEqual([
          'c',
          'd',
        ]);
      });

      it('pages through the whole set without gaps or repeats', async () => {
        const repo = await ordered();
        const order = [{ field: 'slug' as const, direction: 'asc' as const }];
        const seen: string[] = [];
        for (let offset = 0; offset < 4; offset += 2) {
          const page = await repo.findMany({ orderBy: order, limit: 2, offset });
          seen.push(...page.map((r) => r.slug));
        }
        expect(seen).toEqual(['a', 'b', 'c', 'd']);
      });

      it('returns the first row from findOne, honoring order', async () => {
        const repo = await ordered();
        const row = await repo.findOne({ orderBy: [{ field: 'slug', direction: 'desc' }] });
        expect(row?.slug).toBe('d');
        expect(await (await widgets()).findOne()).toBeNull();
      });

      it('rejects a negative limit', async () => {
        const repo = await widgets();
        await expect(repo.findMany({ limit: -1 })).rejects.toBeInstanceOf(QueryError);
      });
    });

    // ----------------------------------------------------------------- cursors

    describe('streaming cursors', () => {
      /** 25 rows with a stable sort key and nulls in the nullable column. */
      async function streamable(): Promise<{ repo: Repo<Widget>; slugs: string[] }> {
        const repo = await widgets();
        const rows = Array.from({ length: 25 }, (_, i) =>
          baseWidget({
            slug: `s-${String(i).padStart(2, '0')}`,
            quantity: i,
            releasedAt: i % 4 === 0 ? null : new Date(1_700_000_000_000 + i * 1000),
          }),
        );
        await repo.createMany(rows);
        return { repo, slugs: rows.map((r) => r.slug as string) };
      }

      const order = [{ field: 'slug' as const, direction: 'asc' as const }];

      it('yields exactly findMany, in the same order', async () => {
        const { repo } = await streamable();
        const expected = (await repo.findMany({ orderBy: order })).map((r) => r.slug);

        const seen: string[] = [];
        for await (const row of repo.stream({ orderBy: order })) seen.push(row.slug);

        expect(seen).toEqual(expected);
      });

      it('returns the same rows whatever the batch size', async () => {
        const { repo } = await streamable();
        const expected = (await repo.findMany({ orderBy: order })).map((r) => r.slug);

        for (const batchSize of [1, 7, 25, 1000]) {
          const seen: string[] = [];
          for await (const row of repo.stream({ orderBy: order }, { batchSize })) {
            seen.push(row.slug);
          }
          expect(seen, `batchSize ${batchSize}`).toEqual(expected);
        }
      });

      it('honors filters, ordering, and limit exactly as findMany does', async () => {
        const { repo } = await streamable();
        const query = {
          where: [{ field: 'quantity' as const, op: 'gte' as const, value: 10 }],
          orderBy: [{ field: 'quantity' as const, direction: 'desc' as const }],
          limit: 5,
        };
        const expected = (await repo.findMany(query)).map((r) => r.slug);

        const seen: string[] = [];
        for await (const row of repo.stream(query, { batchSize: 2 })) seen.push(row.slug);

        expect(seen).toEqual(expected);
      });

      it('round trips every type the way findMany does', async () => {
        const repo = await widgets();
        const meta = { tags: ['a'], n: 1 };
        const released = new Date('2024-03-05T06:07:08.123Z');
        await repo.create(baseWidget({ meta, releasedAt: released, active: false, weight: -2.5 }));

        const [row] = await collect(repo.stream());
        expect(row?.meta).toEqual(meta);
        expect(row?.releasedAt?.getTime()).toBe(released.getTime());
        expect(row?.active).toBe(false);
        expect(row?.weight).toBe(-2.5);
        expect(row?.createdAt).toBeInstanceOf(Date);
      });

      it('terminates immediately on an empty result', async () => {
        const repo = await widgets();
        const seen: Widget[] = [];
        for await (const row of repo.stream()) seen.push(row);
        expect(seen).toEqual([]);
      });

      it('closes cleanly when the consumer breaks out early', async () => {
        const { repo } = await streamable();
        const baseline = adapter.busyConnections?.();

        const seen: string[] = [];
        for await (const row of repo.stream({ orderBy: order }, { batchSize: 2 })) {
          seen.push(row.slug);
          if (seen.length === 3) break;
        }
        expect(seen).toHaveLength(3);

        // The repo has to still work: on Postgres the cursor held an open transaction, and
        // on SQLite it held a read lock.
        expect(await repo.count()).toBe(25);
        await repo.create(baseWidget({ slug: 'after-break' }));

        if (baseline !== undefined) {
          expect(adapter.busyConnections?.()).toBe(baseline);
        }
      });

      it('closes cleanly when the consumer throws inside the loop', async () => {
        const { repo } = await streamable();
        const baseline = adapter.busyConnections?.();
        const boom = new Error('boom');

        await expect(
          (async () => {
            for await (const row of repo.stream({ orderBy: order }, { batchSize: 2 })) {
              if (row.slug === 's-04') throw boom;
            }
          })(),
        ).rejects.toBe(boom);

        expect(await repo.count()).toBe(25);
        if (baseline !== undefined) {
          expect(adapter.busyConnections?.()).toBe(baseline);
        }
      });

      it('never opens a cursor when the iterable is not consumed', async () => {
        const { repo } = await streamable();
        const baseline = adapter.busyConnections?.();
        repo.stream({ orderBy: order });
        if (baseline !== undefined) {
          expect(adapter.busyConnections?.()).toBe(baseline);
        }
        expect(await repo.count()).toBe(25);
      });

      it('stops on an abort signal and throws the reason it was given', async () => {
        const { repo } = await streamable();
        const controller = new AbortController();
        const reason = new Error('cancelled by the caller');

        const seen: string[] = [];
        await expect(
          (async () => {
            for await (const row of repo.stream(
              { orderBy: order },
              { batchSize: 2, signal: controller.signal },
            )) {
              seen.push(row.slug);
              if (seen.length === 2) controller.abort(reason);
            }
          })(),
        ).rejects.toBe(reason);

        // The batch already fetched is still delivered: cancellation takes effect at the
        // next batch boundary rather than mid-batch.
        expect(seen.length).toBeGreaterThanOrEqual(2);
        expect(seen.length).toBeLessThan(25);
        expect(await repo.count()).toBe(25);
      });

      it('refuses a batch size that is not a positive integer', async () => {
        const repo = await widgets();
        for (const batchSize of [0, -1, 1.5]) {
          await expect(collect(repo.stream(undefined, { batchSize }))).rejects.toBeInstanceOf(
            QueryError,
          );
        }
      });

      it('reports a bad query when the iteration starts, not before', async () => {
        const repo = await widgets();
        const iterable = repo.stream({
          where: [{ field: 'nope' as keyof Widget & string, op: 'eq', value: 1 }],
        });
        await expect(collect(iterable)).rejects.toBeInstanceOf(QueryError);
      });
    });

    // ------------------------------------------------------------- keyset paging

    describe('findPage', () => {
      async function paged(count = 10): Promise<Repo<Widget>> {
        const repo = await widgets();
        await repo.createMany(
          Array.from({ length: count }, (_, i) =>
            baseWidget({
              slug: `p-${String(i).padStart(2, '0')}`,
              quantity: i % 3,
              releasedAt: i % 4 === 0 ? null : new Date(1_700_000_000_000 + i * 1000),
            }),
          ),
        );
        return repo;
      }

      /** Walks every page and returns the slugs in the order they were handed back. */
      async function walk(
        repo: Repo<Widget>,
        query: QueryOptions<Widget> | undefined,
        limit: number,
        onPage?: () => Promise<void>,
      ): Promise<string[]> {
        const seen: string[] = [];
        let after: string | null = null;
        for (;;) {
          const page = await repo.findPage(query, { limit, after });
          seen.push(...page.items.map((r) => r.slug));
          if (onPage) await onPage();
          if (!page.hasMore) break;
          expect(page.cursor).toBeTypeOf('string');
          after = page.cursor;
        }
        return seen;
      }

      it('walks the whole set with no gaps and no repeats', async () => {
        const repo = await paged();
        const expected = (
          await repo.findMany({ orderBy: [{ field: 'slug', direction: 'asc' }] })
        ).map((r) => r.slug);

        const seen = await walk(repo, { orderBy: [{ field: 'slug', direction: 'asc' }] }, 3);
        expect(seen).toEqual(expected);
      });

      it('produces the same walk whatever the page size', async () => {
        const repo = await paged();
        const query = { orderBy: [{ field: 'slug' as const, direction: 'desc' as const }] };
        const expected = (await repo.findMany(query)).map((r) => r.slug);

        for (const limit of [1, 2, 7, 100]) {
          expect(await walk(repo, query, limit), `limit ${limit}`).toEqual(expected);
        }
      });

      it('breaks ties with the primary key so a shared sort key cannot skip a row', async () => {
        // quantity has only three distinct values across ten rows, so every page boundary
        // lands inside a tie. Without the primary key appended, this loses rows.
        const repo = await paged();
        const query = { orderBy: [{ field: 'quantity' as const, direction: 'asc' as const }] };
        const seen = await walk(repo, query, 3);
        expect(seen).toHaveLength(10);
        expect(new Set(seen).size).toBe(10);
      });

      it('pages a mixed-direction sort correctly', async () => {
        const repo = await paged();
        const query = {
          orderBy: [
            { field: 'quantity' as const, direction: 'desc' as const },
            { field: 'slug' as const, direction: 'asc' as const },
          ],
        };
        const expected = (await repo.findMany(query)).map((r) => r.slug);
        expect(await walk(repo, query, 3)).toEqual(expected);
      });

      it('pages a nullable sort key, keeping nulls where ORDER BY puts them', async () => {
        const repo = await paged();
        for (const direction of ['asc', 'desc'] as const) {
          const query = { orderBy: [{ field: 'releasedAt' as const, direction }] };
          // The expected set has to be read under the *total* order, with the primary key
          // appended, because that is what findPage pages by. Three rows share a null
          // releasedAt, and comparing against a sort that leaves those three in an
          // undefined order would be comparing against nothing in particular.
          const expected = (
            await repo.findMany({
              orderBy: [
                { field: 'releasedAt' as const, direction },
                { field: 'id' as const, direction: 'asc' as const },
              ],
            })
          ).map((r) => r.slug);
          expect(await walk(repo, query, 2), direction).toEqual(expected);

          // Nulls still land where ORDER BY puts them: last on asc, first on desc.
          const walked = await repo.findMany(query);
          const nullCount = walked.filter((r) => r.releasedAt === null).length;
          const nullsAt =
            direction === 'asc' ? walked.slice(-nullCount) : walked.slice(0, nullCount);
          expect(nullsAt.every((r) => r.releasedAt === null)).toBe(true);
        }
      });

      it('applies the caller filter on every page, not just the first', async () => {
        const repo = await paged();
        const query = {
          where: [{ field: 'quantity' as const, op: 'eq' as const, value: 1 }],
          orderBy: [{ field: 'slug' as const, direction: 'asc' as const }],
        };
        const expected = (await repo.findMany(query)).map((r) => r.slug);
        const seen = await walk(repo, query, 1);
        expect(seen).toEqual(expected);
        expect(seen.length).toBeGreaterThan(1);
      });

      it('neither duplicates nor skips a returned row when rows arrive mid-walk', async () => {
        // The reason keyset paging exists. An OFFSET walk repeats a row here for every
        // insert that lands before the current position.
        const repo = await paged();
        let inserted = 0;
        const seen = await walk(
          repo,
          { orderBy: [{ field: 'slug', direction: 'asc' }] },
          3,
          async () => {
            inserted += 1;
            // Sorts before everything already returned, which is what breaks OFFSET.
            await repo.create(baseWidget({ slug: `a-new-${inserted}` }));
          },
        );

        const original = seen.filter((slug) => slug.startsWith('p-'));
        expect(new Set(seen).size).toBe(seen.length);
        expect(original).toEqual(original.slice().sort());
        expect(new Set(original).size).toBe(10);
      });

      it('reports the last page rather than a cursor that goes nowhere', async () => {
        const repo = await paged(3);
        const page = await repo.findPage(undefined, { limit: 10 });
        expect(page.items).toHaveLength(3);
        expect(page.hasMore).toBe(false);
        expect(page.cursor).toBeNull();
      });

      it('returns an empty first page on an empty table', async () => {
        const repo = await widgets();
        const page = await repo.findPage();
        expect(page).toEqual({ items: [], cursor: null, hasMore: false });
      });

      it('rejects a cursor minted under a different sort order', async () => {
        const repo = await paged();
        const page = await repo.findPage(
          { orderBy: [{ field: 'slug', direction: 'asc' }] },
          { limit: 2 },
        );
        await expect(
          repo.findPage(
            { orderBy: [{ field: 'quantity', direction: 'asc' }] },
            { limit: 2, after: page.cursor },
          ),
        ).rejects.toBeInstanceOf(QueryError);
      });

      it('rejects a malformed cursor', async () => {
        const repo = await paged();
        await expect(
          repo.findPage(undefined, { after: 'not-a-real-cursor' }),
        ).rejects.toBeInstanceOf(QueryError);
      });

      it('rejects an offset, which keyset paging replaces', async () => {
        const repo = await paged();
        await expect(repo.findPage({ offset: 5 })).rejects.toBeInstanceOf(QueryError);
      });

      it('rejects a page limit that is not a positive integer', async () => {
        const repo = await paged();
        await expect(repo.findPage(undefined, { limit: 0 })).rejects.toBeInstanceOf(QueryError);
      });
    });

    // ------------------------------------------------------------------- count

    describe('count', () => {
      it('counts with and without a filter, agreeing with findMany', async () => {
        const repo = await widgets();
        await repo.createMany([
          baseWidget({ active: true }),
          baseWidget({ active: true }),
          baseWidget({ active: false }),
        ]);

        expect(await repo.count()).toBe(3);
        const filter = { where: [{ field: 'active' as const, op: 'eq' as const, value: true }] };
        expect(await repo.count(filter)).toBe(2);
        expect(await repo.count(filter)).toBe((await repo.findMany(filter)).length);
      });

      it('counts zero on an empty table', async () => {
        expect(await (await widgets()).count()).toBe(0);
      });
    });

    // -------------------------------------------------------------- constraints

    describe('constraints', () => {
      it('throws UniqueConstraintError naming the offending field', async () => {
        const repo = await widgets();
        await repo.create(baseWidget({ slug: 'taken' }));

        const error = await repo.create(baseWidget({ slug: 'taken' })).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(UniqueConstraintError);
        expect((error as UniqueConstraintError).fields).toContain('slug');
      });
    });

    // ------------------------------------------------------- ids and timestamps

    describe('ids and timestamps', () => {
      it('generates a uuid when none is supplied', async () => {
        const repo = await widgets({ ids: 'uuid' });
        const created = await repo.create(baseWidget());
        expect(created.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
      });

      it('honors a caller-supplied id under the provided strategy', async () => {
        const repo = await widgets({ ids: 'provided' });
        const created = await repo.create(baseWidget({ id: 'chosen-id' }));
        expect(created.id).toBe('chosen-id');
        expect((await repo.findById('chosen-id'))?.id).toBe('chosen-id');
      });

      it('requires an id under the provided strategy', async () => {
        const repo = await widgets({ ids: 'provided' });
        await expect(repo.create(baseWidget())).rejects.toBeInstanceOf(QueryError);
      });

      it('sets createdAt once and advances updatedAt on write', async () => {
        const repo = await widgets({ timestamps: true });
        const created = await repo.create(baseWidget());

        expect(created.createdAt).toBeInstanceOf(Date);
        expect(created.updatedAt.getTime()).toBe(created.createdAt.getTime());

        await new Promise((resolve) => setTimeout(resolve, 5));
        const updated = await repo.update(created.id, { name: 'changed' });

        expect(updated.createdAt.getTime()).toBe(created.createdAt.getTime());
        expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
      });
    });

    // ------------------------------------------------------------------- errors

    describe('query errors', () => {
      it('rejects an unknown field in where before touching the database', async () => {
        const repo = await widgets();
        await expect(
          repo.findMany({
            where: [{ field: 'nope' as keyof Widget & string, op: 'eq', value: 1 }],
          }),
        ).rejects.toBeInstanceOf(QueryError);
      });

      it('rejects an unknown field in orderBy', async () => {
        const repo = await widgets();
        await expect(
          repo.findMany({
            orderBy: [{ field: 'nope' as keyof Widget & string, direction: 'asc' }],
          }),
        ).rejects.toBeInstanceOf(QueryError);
      });

      it('rejects an unknown operator', async () => {
        const repo = await widgets();
        await expect(
          repo.findMany({
            where: [{ field: 'name', op: 'regex' as 'eq', value: 'x' }],
          }),
        ).rejects.toBeInstanceOf(QueryError);
      });

      it('rejects an unknown field on create', async () => {
        const repo = await widgets();
        await expect(
          repo.create({ ...baseWidget(), bogus: 1 } as Partial<Widget>),
        ).rejects.toBeInstanceOf(QueryError);
      });
    });

    // ------------------------------------------------------------- transactions

    const txReason = unsupported.transactions;
    const describeTx = txReason ? describe.skip : describe;

    if (txReason) {
      it(`declares transactions unsupported: ${txReason}`, () => {
        expect(txReason).toBeTypeOf('string');
      });
    }

    describeTx('transactions', () => {
      it('commits when the callback returns', async () => {
        const repo = await widgets();
        const created = await repo.withTransaction(async (tx) => tx.create(baseWidget()));
        expect(await repo.findById(created.id)).not.toBeNull();
      });

      it('returns the callback value', async () => {
        const repo = await widgets();
        expect(await repo.withTransaction(async () => 42)).toBe(42);
      });

      it('rolls back everything when the callback throws', async () => {
        const repo = await widgets();
        const boom = new Error('boom');

        await expect(
          repo.withTransaction(async (tx) => {
            await tx.create(baseWidget());
            await tx.create(baseWidget());
            throw boom;
          }),
        ).rejects.toBe(boom);

        expect(await repo.count()).toBe(0);
      });

      it('leaves work committed before the transaction untouched', async () => {
        const repo = await widgets();
        const before = await repo.create(baseWidget());

        await repo
          .withTransaction(async (tx) => {
            await tx.create(baseWidget());
            throw new Error('nope');
          })
          .catch(() => undefined);

        expect(await repo.count()).toBe(1);
        expect(await repo.findById(before.id)).not.toBeNull();
      });

      it('rolls back a nested savepoint without losing the outer transaction', async () => {
        const repo = await widgets();

        const outer = await repo.withTransaction(async (tx) => {
          const kept = await tx.create(baseWidget({ slug: 'kept' }));

          await tx
            .withTransaction(async (inner) => {
              await inner.create(baseWidget({ slug: 'discarded' }));
              throw new Error('inner failure');
            })
            .catch(() => undefined);

          return kept;
        });

        const rows = await repo.findMany();
        expect(rows.map((r) => r.slug)).toEqual(['kept']);
        expect(outer.slug).toBe('kept');
      });

      it('commits a nested savepoint along with its parent', async () => {
        const repo = await widgets();
        await repo.withTransaction(async (tx) => {
          await tx.create(baseWidget({ slug: 'outer' }));
          await tx.withTransaction(async (inner) => {
            await inner.create(baseWidget({ slug: 'inner' }));
          });
        });
        expect((await repo.findMany()).map((r) => r.slug).sort()).toEqual(['inner', 'outer']);
      });

      it('lets a second repo join the same transaction via with(ctx)', async () => {
        const table = uniqueTable('widgets');
        const widgetRepo = await adapter.createRepo<Widget>({
          schema: widgetSchema,
          table,
          timestamps: true,
        });
        const noteRepo = await adapter.createRepo<Note>({
          schema: noteSchema,
          table: uniqueTable('notes'),
        });

        await expect(
          widgetRepo.withTransaction(async (tx, ctx: TxContext) => {
            await tx.create(baseWidget());
            await noteRepo.with(ctx).create({ body: 'note' });
            throw new Error('roll it all back');
          }),
        ).rejects.toThrow('roll it all back');

        // Both repos must be rolled back, which only happens if they truly shared one
        // connection rather than each opening their own.
        expect(await widgetRepo.count()).toBe(0);
        expect(await noteRepo.count()).toBe(0);
      });

      it('sees its own uncommitted writes inside the transaction', async () => {
        const repo = await widgets();
        await repo.withTransaction(async (tx) => {
          const created = await tx.create(baseWidget());
          expect(await tx.findById(created.id)).not.toBeNull();
          expect(await tx.count()).toBe(1);
        });
      });

      it('lets a stream inside a transaction see and feed uncommitted writes', async () => {
        // The cursor runs on the transaction's own connection, so a write made inside the
        // loop is part of the same transaction and rolls back with it. On Postgres this is
        // the difference between the cursor joining the transaction and opening its own.
        const widgetRepo = await widgets();
        const noteRepo = await adapter.createRepo<Note>({
          schema: noteSchema,
          table: uniqueTable('notes'),
        });
        await widgetRepo.createMany([
          baseWidget({ slug: 'w-1' }),
          baseWidget({ slug: 'w-2' }),
          baseWidget({ slug: 'w-3' }),
        ]);

        await expect(
          widgetRepo.withTransaction(async (tx, ctx: TxContext) => {
            const notes = noteRepo.with(ctx);
            for await (const row of tx.stream(
              { orderBy: [{ field: 'slug', direction: 'asc' }] },
              { batchSize: 1 },
            )) {
              // Writing to a second table rather than the streamed one: mutating a table
              // while a cursor walks it is unspecified on SQLite, and documented as such.
              await notes.create({ body: row.slug });
            }
            expect(await notes.count()).toBe(3);
            throw new Error('roll it back');
          }),
        ).rejects.toThrow('roll it back');

        expect(await noteRepo.count()).toBe(0);
      });

      it('stays usable after a rolled-back transaction', async () => {
        const repo = await widgets();
        await repo
          .withTransaction(async () => {
            throw new Error('fail');
          })
          .catch(() => undefined);

        const created = await repo.create(baseWidget());
        expect(await repo.findById(created.id)).not.toBeNull();
      });
    });
  });
}
