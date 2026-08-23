# repolayer

[![CI](https://github.com/CuplexUser/Repolayer/actions/workflows/ci.yml/badge.svg)](https://github.com/CuplexUser/Repolayer/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/repolayer.svg)](https://www.npmjs.com/package/repolayer)

Define your data access once against a plain interface, and swap the storage engine
underneath without touching application code.

Start on SQLite because it needs no setup and lives in a file. Move to Postgres, MySQL, or
MariaDB when you need concurrent writers, hosted scaling, or more than one instance. Change
one config value instead of rewriting every query.

```ts
const repo = await createRepo<Puzzle>({
  driver: 'sqlite',                    // <- the only line that changes
  table: 'puzzles',
  schema: puzzleSchema,
  connection: { file: './data.db' },
});
```

## Installation

```bash
npm install repolayer
npm install pg       # only for the Postgres driver
npm install mysql2   # only for the MySQL or MariaDB driver
```

Both are optional peer dependencies, imported lazily, so a project on one engine never loads
the other one's driver and does not need it installed. Requires Node 22.5 or newer; see
[engines.md](docs/engines.md) for the `node:sqlite` version details.

## Usage

Describe the table with a plain object. No validator library, no peer dependency.

```ts
import { createRepo, defineSchema, type Infer } from 'repolayer';

const puzzleSchema = defineSchema({
  id:         { type: 'string',  primaryKey: true },
  title:      { type: 'string' },
  slug:       { type: 'string',  unique: true },
  difficulty: { type: 'integer' },
  solved:     { type: 'boolean' },
  tags:       { type: 'json',    nullable: true },
  createdAt:  { type: 'date',    column: 'created_at' },
  updatedAt:  { type: 'date',    column: 'updated_at' },
});

type Puzzle = Infer<typeof puzzleSchema>;
```

Then use it. Every method means the same thing on every engine, which is checked by one
shared conformance suite rather than asserted in a README.

```ts
const repo = await createRepo<Puzzle>({
  driver: 'sqlite',
  table: 'puzzles',
  schema: puzzleSchema,
  connection: { file: './data.db' },
  timestamps: true,
  ensureTable: true,
});

const puzzle = await repo.create({ title: 'Sudoku', difficulty: 3, solved: false });

await repo.findById(puzzle.id);
await repo.findOne({ where: { slug: 'sudoku' } });
await repo.count({ where: [{ field: 'difficulty', op: 'gte', value: 5 }] });

await repo.findMany({
  where: [
    { field: 'solved', op: 'eq', value: false },
    { field: 'title',  op: 'ilike', value: 'sud%' },
  ],
  orderBy: [{ field: 'createdAt', direction: 'desc' }],
  limit: 20,
});

await repo.update(puzzle.id, { solved: true });   // throws NotFoundError if it is gone
await repo.deleteMany({ where: { solved: true } });

await repo.withTransaction(async (tx) => { /* returning commits, throwing rolls back */ });

for await (const row of repo.stream({ where: { solved: false } })) { /* batched */ }
await repo.findPage({ orderBy: [{ field: 'createdAt', direction: 'desc' }] }, { limit: 20 });
```

## What this is not

Not an ORM. There is no query builder DSL to learn, no migration engine, no relationship
mapping, and no lazy-loading magic. It is a deliberately boring contract: a `Repo<T>`
interface with predictable methods, a small serializable query shape, and four adapters that
satisfy it identically.

The filter language is kept small on purpose. Most ORMs leak the moment you need something
dialect specific; a restricted query shape is what lets two very different engines behave the
same way, and it is why the abstraction can hold.

## Documentation

- [API](docs/api.md) - every export, method by method
- [Queries](docs/queries.md) - filters, filter trees, operators, ordering, limits
- [Streaming and paging](docs/streaming.md) - cursors, cancellation, keyset pagination
- [Engines](docs/engines.md) - what is normalized, what differs, MySQL and MariaDB specifics
- [Testing](docs/testing.md) - `MemoryRepo`, and the conformance suite for adapter authors
- [Contributing](docs/contributing.md) - development, running the engine suites, releasing
- [Roadmap](ROADMAP.md) - what is shipped, what is coming, what is never coming

## License

MIT
