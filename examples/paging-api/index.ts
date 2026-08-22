/**
 * Keyset paging, and why it is not `limit`/`offset`.
 *
 * This script pages through the same data twice while rows are being inserted underneath
 * it: once with `findPage`, once with the offset paging most APIs ship with. Offset paging
 * repeats rows it has already returned. Keyset paging does not. That is the whole argument
 * for the cursor token, executed rather than asserted.
 *
 *   npm run example:paging-api
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import { createRepo, defineSchema, type Infer } from '../../dist/index.js';

const postSchema = defineSchema({
  id: { type: 'string', primaryKey: true },
  title: { type: 'string' },
  score: { type: 'integer' },
  publishedAt: { type: 'date', nullable: true, column: 'published_at' },
});

type Post = Infer<typeof postSchema>;

const dir = mkdtempSync(path.join(tmpdir(), 'repolayer-paging-'));

const repo = await createRepo<Post>({
  driver: 'sqlite',
  table: 'posts',
  schema: postSchema,
  connection: { file: path.join(dir, 'posts.db') },
  ensureTable: true,
});

/** Sorted newest first, which is what an API of this shape almost always wants. */
const newestFirst = { orderBy: [{ field: 'publishedAt' as const, direction: 'desc' as const }] };

try {
  await repo.createMany(
    Array.from({ length: 12 }, (_, i) => ({
      title: `post-${String(i).padStart(2, '0')}`,
      score: i % 4,
      // Two rows are unpublished. They are the ones that make the null ordering matter.
      publishedAt: i % 6 === 0 ? null : new Date(1_700_000_000_000 + i * 60_000),
    })),
  );

  // ------------------------------------------------------- the endpoint itself

  /** What an HTTP handler would return: a page of rows and a token for the next one. */
  async function getPage(
    cursor: string | null,
  ): Promise<{ titles: string[]; next: string | null }> {
    const page = await repo.findPage(newestFirst, { limit: 4, after: cursor });
    return { titles: page.items.map((p) => p.title), next: page.hasMore ? page.cursor : null };
  }

  console.log('--- paging with a stable table ---');
  let cursor: string | null = null;
  const walked: string[] = [];
  do {
    const page: { titles: string[]; next: string | null } = await getPage(cursor);
    walked.push(...page.titles);
    console.log(`page: ${page.titles.join(', ')}`);
    cursor = page.next;
  } while (cursor !== null);

  // The walk must reconstruct exactly what one unpaged query returns, nulls included. The
  // comparison reads that query under the *total* order, with the primary key appended,
  // because appending it is what findPage does: two rows here share a null publishedAt, and
  // a sort that leaves those two in an undefined order is nothing to compare against.
  const totalOrder = {
    orderBy: [...newestFirst.orderBy, { field: 'id' as const, direction: 'asc' as const }],
  };
  const unpaged = (await repo.findMany(totalOrder)).map((p) => p.title);
  assert.deepEqual(walked, unpaged, 'the paged walk did not match the unpaged query');
  console.log(`walked ${walked.length} rows, identical to one unpaged query`);

  // The token is opaque and URL safe, so it can go straight into a query string.
  const first = await repo.findPage(newestFirst, { limit: 4 });
  console.log(`cursor: ${String(first.cursor).slice(0, 32)}...`);
  assert.match(String(first.cursor), /^[A-Za-z0-9_-]+$/);

  // ------------------------------------------- inserts landing during the walk

  console.log('\n--- paging while rows are being inserted ---');

  /** Inserts a row that sorts to the very front of the order. */
  async function insertAtFront(n: number): Promise<void> {
    await repo.create({
      title: `arrived-${n}`,
      score: 0,
      publishedAt: new Date(1_800_000_000_000 + n * 1000),
    });
  }

  const keyset: string[] = [];
  cursor = null;
  let inserted = 0;
  do {
    const page: { titles: string[]; next: string | null } = await getPage(cursor);
    keyset.push(...page.titles);
    cursor = page.next;
    inserted += 1;
    await insertAtFront(inserted);
  } while (cursor !== null);

  const keysetRepeats = keyset.length - new Set(keyset).size;
  console.log(`keyset: ${keyset.length} rows returned, ${keysetRepeats} of them repeats`);

  // The same walk, done the way most APIs do it.
  await repo.deleteMany({ where: [{ field: 'title', op: 'like', value: 'arrived-%' }] });

  const offset: string[] = [];
  inserted = 0;
  for (let skip = 0; ; skip += 4) {
    const rows = await repo.findMany({ ...newestFirst, limit: 4, offset: skip });
    if (rows.length === 0) break;
    offset.push(...rows.map((p) => p.title));
    inserted += 1;
    await insertAtFront(100 + inserted);
  }

  const offsetRepeats = offset.length - new Set(offset).size;
  console.log(`offset: ${offset.length} rows returned, ${offsetRepeats} of them repeats`);

  assert.equal(keysetRepeats, 0, 'keyset paging repeated a row, which it must never do');
  assert.ok(
    offsetRepeats > 0,
    'offset paging did not repeat a row here, so this example is not demonstrating anything',
  );
  console.log(
    `\nEvery insert that lands before the current position shifts an offset window by one, ` +
      `so offset paging shows ${offsetRepeats} row(s) twice. A cursor names where it left ` +
      `off, so nothing shifts under it.`,
  );

  // ------------------------------------------------------------- token safety

  console.log('\n--- a cursor is only valid for the sort that made it ---');
  const bySorted = await repo.findPage(newestFirst, { limit: 2 });
  try {
    await repo.findPage(
      { orderBy: [{ field: 'score', direction: 'asc' }] },
      { limit: 2, after: bySorted.cursor },
    );
    assert.fail('reusing a cursor under a different sort should have been refused');
  } catch (error) {
    console.log(`refused: ${(error as Error).message.split('.')[0]}.`);
  }
} finally {
  await repo.close();
  rmSync(dir, { recursive: true, force: true });
}
