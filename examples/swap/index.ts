/**
 * The package's central claim, executed.
 *
 * One schema, one piece of repository logic, run against SQLite and then against
 * Postgres with a single config value changed. The two runs must produce byte-identical
 * output. If they ever do not, the abstraction has sprung a leak and this script says so
 * with a non-zero exit code.
 *
 *   node --experimental-strip-types examples/swap/index.ts
 *   TEST_DATABASE_URL=postgres://... node --experimental-strip-types examples/swap/index.ts
 *
 * Without TEST_DATABASE_URL it runs the SQLite half only and says so.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// Imports the built package exactly as a consumer would, so this also checks that the
// build output and its type declarations actually work.
import { createRepo, defineSchema, type Infer, type Repo } from '../../dist/index.js';

const puzzleSchema = defineSchema({
  id: { type: 'string', primaryKey: true },
  title: { type: 'string' },
  difficulty: { type: 'integer' },
  solved: { type: 'boolean' },
  tags: { type: 'json', nullable: true },
  solvedAt: { type: 'date', nullable: true, column: 'solved_at' },
  createdAt: { type: 'date', column: 'created_at' },
  updatedAt: { type: 'date', column: 'updated_at' },
});

type Puzzle = Infer<typeof puzzleSchema>;

/**
 * The application logic under test. Note what is absent: any mention of SQLite, Postgres,
 * SQL, or a driver. This function is what you would write once and never revisit after
 * changing engines.
 */
async function exerciseRepo(repo: Repo<Puzzle>): Promise<string> {
  const lines: string[] = [];

  await repo.createMany([
    { title: 'Sudoku', difficulty: 3, solved: true, tags: ['grid'], solvedAt: new Date(0) },
    { title: 'Crossword', difficulty: 5, solved: false, tags: null, solvedAt: null },
    { title: 'nonogram', difficulty: 5, solved: true, tags: ['grid', 'logic'], solvedAt: null },
    { title: 'Kakuro', difficulty: 1, solved: false, tags: [], solvedAt: new Date(86_400_000) },
  ]);

  lines.push(`count: ${await repo.count()}`);
  lines.push(`hard: ${await repo.count({ where: [{ field: 'difficulty', op: 'gte', value: 5 }] })}`);

  // Case sensitivity is normalized, so these two disagree the same way on both engines.
  const likeRows = await repo.findMany({ where: [{ field: 'title', op: 'like', value: '%o%' }] });
  lines.push(`like %o%: ${likeRows.map((p) => p.title).sort().join(',')}`);
  const ilikeRows = await repo.findMany({ where: [{ field: 'title', op: 'ilike', value: 'N%' }] });
  lines.push(`ilike N%: ${ilikeRows.map((p) => p.title).join(',')}`);

  // Null ordering is normalized, so the two engines agree on where the nulls land.
  const ordered = await repo.findMany({ orderBy: [{ field: 'solvedAt', direction: 'asc' }] });
  lines.push(`by solvedAt asc: ${ordered.map((p) => p.title).join(',')}`);

  const page = await repo.findMany({
    orderBy: [{ field: 'title', direction: 'asc' }],
    limit: 2,
    offset: 1,
  });
  lines.push(`page: ${page.map((p) => p.title).join(',')}`);

  const first = await repo.findOne({ orderBy: [{ field: 'title', direction: 'asc' }] });
  const updated = await repo.update(first!.id, { solved: true, difficulty: 9 });
  lines.push(`updated: ${updated.title} solved=${updated.solved} difficulty=${updated.difficulty}`);
  lines.push(`tags round trip: ${JSON.stringify(updated.tags)}`);

  // A transaction that rolls back must leave nothing behind, on either engine.
  await repo
    .withTransaction(async (tx) => {
      await tx.create({ title: 'Ghost', difficulty: 1, solved: false, tags: null, solvedAt: null });
      throw new Error('rollback');
    })
    .catch(() => undefined);
  lines.push(`after rollback: ${await repo.count()}`);

  await repo.delete(updated.id);
  lines.push(`after delete: ${await repo.count()}`);

  return lines.join('\n');
}

async function runSqlite(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'repolayer-swap-'));
  const repo = await createRepo<Puzzle>({
    driver: 'sqlite', // <- the only line that changes
    table: 'puzzles',
    schema: puzzleSchema,
    connection: { file: path.join(dir, 'swap.db') },
    timestamps: true,
    ensureTable: true,
  });
  try {
    return await exerciseRepo(repo);
  } finally {
    await repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runPostgres(connectionString: string): Promise<string> {
  const repo = await createRepo<Puzzle>({
    driver: 'postgres', // <- the only line that changes
    table: 'puzzles_swap_example',
    schema: puzzleSchema,
    connection: { connectionString },
    timestamps: true,
    ensureTable: true,
  });
  try {
    // Start from a clean table so repeat runs produce the same output.
    await repo.deleteMany();
    return await exerciseRepo(repo);
  } finally {
    await repo.close();
  }
}

const sqliteOutput = await runSqlite();
console.log('--- sqlite ---');
console.log(sqliteOutput);

const url = process.env['TEST_DATABASE_URL'];
if (!url) {
  console.log('\n--- postgres ---');
  console.log('skipped: set TEST_DATABASE_URL to run the Postgres half and compare.');
} else {
  const postgresOutput = await runPostgres(url);
  console.log('\n--- postgres ---');
  console.log(postgresOutput);

  assert.equal(
    postgresOutput,
    sqliteOutput,
    'The two drivers produced different output. That is a leak in the abstraction.',
  );
  console.log('\nidentical output on both drivers.');
}
