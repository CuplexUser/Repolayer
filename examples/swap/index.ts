/**
 * The package's central claim, executed.
 *
 * One schema, one piece of repository logic, run against SQLite, then Postgres, then
 * MySQL, then MariaDB, with a single config value changed each time. Every run must
 * produce byte-identical output. If any of them differs, the abstraction has sprung a leak
 * and this script says so with a non-zero exit code.
 *
 *   npm run example:swap
 *   TEST_DATABASE_URL=postgres://... TEST_MYSQL_URL=mysql://... npm run example:swap
 *
 * Engines whose URL is absent are skipped, and the script says which.
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
  lines.push(
    `hard: ${await repo.count({ where: [{ field: 'difficulty', op: 'gte', value: 5 }] })}`,
  );

  // Case sensitivity is normalized, so these two disagree the same way on both engines.
  const likeRows = await repo.findMany({ where: [{ field: 'title', op: 'like', value: '%o%' }] });
  lines.push(
    `like %o%: ${likeRows
      .map((p) => p.title)
      .sort()
      .join(',')}`,
  );
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

  // A filter tree has to group the same way everywhere, parentheses and all.
  const grouped = await repo.findMany({
    where: [
      { field: 'solved', op: 'eq', value: true },
      {
        or: [
          { field: 'difficulty', op: 'gte', value: 5 },
          { field: 'title', op: 'eq', value: 'Sudoku' },
        ],
      },
    ],
    orderBy: [{ field: 'title', direction: 'asc' }],
  });
  lines.push(`solved and (hard or sudoku): ${grouped.map((p) => p.title).join(',')}`);

  // A cursor walks the same rows in the same order as findMany, in batches.
  const streamed: string[] = [];
  for await (const puzzle of repo.stream(
    { orderBy: [{ field: 'title', direction: 'asc' }] },
    { batchSize: 2 },
  )) {
    streamed.push(puzzle.title);
  }
  lines.push(`streamed: ${streamed.join(',')}`);

  // Keyset paging walked to exhaustion has to reconstruct the whole ordered set, including
  // where the nulls land, on every engine.
  const walked: string[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await repo.findPage(
      { orderBy: [{ field: 'solvedAt', direction: 'desc' }] },
      { limit: 2, after },
    );
    walked.push(...page.items.map((p) => p.title));
    if (!page.hasMore) break;
    after = page.cursor;
  }
  lines.push(`paged by solvedAt desc: ${walked.join(',')}`);

  const bumped = await repo.updateMany({ where: { solved: false } }, { difficulty: 2 });
  lines.push(`updateMany: ${bumped}`);

  // A transaction that rolls back must leave nothing behind, on any engine.
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

async function runServer(driver: 'postgres' | 'mysql', connectionString: string): Promise<string> {
  const repo = await createRepo<Puzzle>({
    driver, // <- the only line that changes
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

/**
 * Every engine that has a URL. MariaDB rides the same driver as MySQL, which is the point
 * of them sharing one adapter.
 */
const servers = [
  { name: 'postgres', driver: 'postgres', env: 'TEST_DATABASE_URL' },
  { name: 'mysql', driver: 'mysql', env: 'TEST_MYSQL_URL' },
  { name: 'mariadb', driver: 'mysql', env: 'TEST_MARIADB_URL' },
] as const;

const compared: string[] = ['sqlite'];

for (const server of servers) {
  const url = process.env[server.env];
  console.log(`\n--- ${server.name} ---`);
  if (!url) {
    console.log(`skipped: set ${server.env} to run this engine and compare.`);
    continue;
  }

  const output = await runServer(server.driver, url);
  console.log(output);

  assert.equal(
    output,
    sqliteOutput,
    `${server.name} produced different output than sqlite. That is a leak in the abstraction.`,
  );
  compared.push(server.name);
}

console.log(
  compared.length > 1
    ? `\nidentical output on ${compared.join(', ')}.`
    : '\nonly sqlite ran. Set the other engine URLs to compare against it.',
);
