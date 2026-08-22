/**
 * Exporting a table larger than you want in memory, with `repo.stream()`.
 *
 * The interesting part is not the happy path, it is what happens when you leave the loop
 * early. A cursor holds a real resource for as long as it is open (an open transaction on
 * Postgres, a read lock on SQLite), so this script deliberately breaks out of one loop and
 * cancels another, then keeps using the repo afterwards. If the cursor were leaked, the
 * work after it would hang or fail.
 *
 *   npm run example:stream-export
 */
import { createWriteStream } from 'node:fs';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import { createRepo, defineSchema, type Infer } from '../../dist/index.js';

const eventSchema = defineSchema({
  id: { type: 'string', primaryKey: true },
  kind: { type: 'string' },
  payload: { type: 'json', nullable: true },
  at: { type: 'date', column: 'occurred_at' },
});

type Event = Infer<typeof eventSchema>;

const ROWS = 5_000;

const dir = mkdtempSync(path.join(tmpdir(), 'repolayer-stream-'));

const repo = await createRepo<Event>({
  driver: 'sqlite',
  table: 'events',
  schema: eventSchema,
  connection: { file: path.join(dir, 'events.db') },
  ensureTable: true,
});

try {
  // Seed in batches, because a single 5,000 row INSERT is a lot of bound parameters.
  for (let batch = 0; batch < ROWS / 500; batch += 1) {
    await repo.createMany(
      Array.from({ length: 500 }, (_, i) => {
        const n = batch * 500 + i;
        return {
          kind: n % 3 === 0 ? 'click' : 'view',
          payload: { n, tags: ['a', 'b'] },
          at: new Date(1_700_000_000_000 + n * 1000),
        };
      }),
    );
  }
  console.log(`seeded ${await repo.count()} events`);

  // ---------------------------------------------------------------- full export

  const file = path.join(dir, 'events.ndjson');
  let exported = 0;

  // The stream is an AsyncIterable, so it plugs straight into node:stream. Rows are
  // converted and written as they arrive; the whole table is never in memory at once.
  await pipeline(
    Readable.from(
      (async function* lines() {
        for await (const event of repo.stream(
          {
            where: [{ field: 'kind', op: 'eq', value: 'view' }],
            orderBy: [{ field: 'at', direction: 'asc' }],
          },
          { batchSize: 500 },
        )) {
          exported += 1;
          yield `${JSON.stringify({ ...event, at: event.at.toISOString() })}\n`;
        }
      })(),
    ),
    createWriteStream(file),
  );

  console.log(`exported ${exported} rows to ${path.basename(file)}`);
  console.log(`file size: ${statSync(file).size} bytes`);
  assert.equal(exported, await repo.count({ where: { kind: 'view' } }));

  // ---------------------------------------------------------------- early exit

  // Reading the first page of a big table and walking away. The cursor has to close.
  const firstTen: string[] = [];
  for await (const event of repo.stream({ orderBy: [{ field: 'at', direction: 'asc' }] })) {
    firstTen.push(event.kind);
    if (firstTen.length === 10) break;
  }
  console.log(`took ${firstTen.length} rows and left the loop early`);

  // If the break had leaked the cursor, this write would block behind it on SQLite, and on
  // Postgres it would have cost a pooled connection that never comes back.
  await repo.create({ kind: 'after-break', payload: null, at: new Date() });
  console.log(`repo still usable: ${await repo.count()} events`);

  // ---------------------------------------------------------------- cancellation

  // A long export cancelled from outside the loop, which is what a request timeout or a
  // shutdown signal looks like.
  const controller = new AbortController();
  const timeout = new Error('export cancelled after its deadline');
  let seen = 0;

  try {
    for await (const _event of repo.stream(undefined, {
      batchSize: 100,
      signal: controller.signal,
    })) {
      seen += 1;
      if (seen === 250) controller.abort(timeout);
    }
    assert.fail('the abort should have ended the loop');
  } catch (error) {
    assert.equal(error, timeout);
    console.log(`cancelled after ${seen} rows, with the reason the caller gave`);
  }

  console.log(`repo still usable: ${await repo.count()} events`);
} finally {
  await repo.close();
  rmSync(dir, { recursive: true, force: true });
}
