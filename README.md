# repolayer

Define your data access once against a plain interface, and swap the storage engine
underneath without touching application code.

Start on SQLite because it needs no setup and lives in a file. Move to Postgres when you
need concurrent writers, hosted scaling, or more than one instance. Change one config
value instead of rewriting every query.

```ts
const repo = await createRepo<Puzzle>({
  driver: 'sqlite',                    // <- the only line that changes
  table: 'puzzles',
  schema: puzzleSchema,
  connection: { file: './data.db' },
});
```

## What this is not

Not an ORM. There is no query builder DSL to learn, no migration engine, no relationship
mapping, and no lazy-loading magic. It is a deliberately boring contract: a `Repo<T>`
interface with predictable methods, a small serializable query shape, and two adapters
that satisfy it identically.

The filter language is kept small on purpose. Most ORMs leak the moment you need something
dialect specific; a restricted query shape is what lets two very different engines behave
the same way, and it is why the abstraction can hold.

## Install

```bash
npm install repolayer
npm install pg     # only if you use the Postgres driver
```

Requires Node 22.5 or newer. `node:sqlite` is stable on Node 24+, unflagged on 23.4+, and
needs `--experimental-sqlite` on 22.5 through 23.3. The core and Postgres paths have no
such constraint.

## Define a schema

The schema descriptor is a plain object. No validator library, no peer dependency. It
tells the adapters how to name columns, how to serialize each type, and how to generate
DDL for local development.

```ts
import { defineSchema, type Infer } from 'repolayer';

const puzzleSchema = defineSchema({
  id:         { type: 'string',  primaryKey: true },
  title:      { type: 'string' },
  slug:       { type: 'string',  unique: true },
  difficulty: { type: 'integer' },
  solved:     { type: 'boolean' },
  tags:       { type: 'json',    nullable: true },
  solvedAt:   { type: 'date',    nullable: true, column: 'solved_at' },
  createdAt:  { type: 'date',    column: 'created_at' },
  updatedAt:  { type: 'date',    column: 'updated_at' },
});

type Puzzle = Infer<typeof puzzleSchema>;
// { id: string; title: string; ...; tags: unknown | null; solvedAt: Date | null; ... }
```

Field types are `string`, `number`, `integer`, `boolean`, `date`, and `json`. Anything more
exotic belongs in a `json` field rather than in a dialect-specific column type.

## Use it

```ts
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
  offset: 40,
});

await repo.update(puzzle.id, { solved: true });   // throws NotFoundError if it is gone
await repo.delete(puzzle.id);
await repo.deleteMany({ where: { solved: true } });
```

`where` also accepts an object, read as an implicit AND of equality checks:
`{ where: { solved: false, difficulty: 5 } }`.

### Operators

| operator | meaning | notes |
|---|---|---|
| `eq` | equals | `value: null` means IS NULL |
| `ne` | not equals | keeps NULL rows, which raw SQL would drop |
| `gt` `gte` `lt` `lte` | comparison | |
| `in` | one of | empty array matches nothing |
| `nin` | none of | empty array matches everything, keeps NULL rows |
| `like` | pattern, case **sensitive** | `%` and `_` wildcards |
| `ilike` | pattern, case **insensitive** | |
| `isNull` | is null | `value: false` inverts it |

### Errors

Every adapter maps its driver's failures onto the same types, so you can branch on them
without knowing which engine is underneath.

```ts
import { NotFoundError, UniqueConstraintError, QueryError } from 'repolayer';

try {
  await repo.create({ slug: 'taken', /* ... */ });
} catch (error) {
  if (error instanceof UniqueConstraintError) {
    console.log(error.fields);   // ['slug'] on both SQLite and Postgres
  }
}
```

`RepoError` is the base. `NotFoundError`, `UniqueConstraintError`, `QueryError`,
`ConnectionError`, and `SchemaError` extend it.

### Ids and timestamps

```ts
createRepo({ /* ... */ ids: 'uuid', timestamps: true });
```

`ids` is `'uuid'` (default, `crypto.randomUUID`), `'autoincrement'` (needs an integer
primary key), or `'provided'` (you supply it). `timestamps: true` uses `createdAt` and
`updatedAt`; pass an object to name them yourself.

Both are set in JavaScript rather than by database defaults, so the two engines produce the
same value at the same precision.

### Transactions

```ts
await repo.withTransaction(async (tx) => {
  await tx.create({ /* ... */ });
  await tx.update(id, { /* ... */ });
});   // returning commits, throwing rolls back
```

Nested calls become savepoints rather than an error. To involve a second table, pass the
context along:

```ts
await users.withTransaction(async (tx, ctx) => {
  const user = await tx.create({ /* ... */ });
  await orders.with(ctx).create({ userId: user.id });   // same connection, same transaction
});
```

`repo.with(ctx)` requires both repos to share a connection. Repos pointed at the same
SQLite file share one automatically; Postgres repos need to be built from the same pool.

### Tables

```ts
await repo.ensureTable();     // or ensureTable: true in createRepo
```

This generates `CREATE TABLE IF NOT EXISTS` from your schema. It is a local-development and
testing convenience, **not a migration engine**: it never alters an existing table and will
not notice drift. Once a schema is in production, pair repolayer with a real migration tool
such as `node-pg-migrate` for Postgres or a small SQL-file runner for SQLite. Keeping
migrations out is what keeps this package small.

## Where the engines genuinely differ

The abstraction normalizes what it honestly can, and documents the rest rather than
pretending. What is normalized:

- **`like` case sensitivity.** SQLite's LIKE is case insensitive for ASCII by default and
  Postgres's is not. The SQLite adapter sets `PRAGMA case_sensitive_like = ON`, so `like`
  is case sensitive and `ilike` is not, on both.
- **NULL ordering.** Postgres sorts NULLs last on ASC, SQLite sorts them first. Every
  generated `ORDER BY` states the position explicitly, so a paged result set survives a
  driver swap.
- **Storage types.** Booleans, dates, and JSON are stored differently and round trip
  through real `boolean`, `Date`, and parsed JSON values on both.
- **Constraint errors.** `SQLITE_CONSTRAINT_UNIQUE` and SQLSTATE `23505` both become
  `UniqueConstraintError`.

What is not, and cannot be:

- **SQLite allows one writer at a time.** Concurrent write transactions serialize, and a
  slow transaction blocks other writers for its whole duration. WAL mode and a 5 second
  `busy_timeout` are on by default, but the model itself does not change. This is usually
  the reason to move to Postgres, and it is a real difference rather than a bug.
- **Transaction isolation.** SQLite is effectively serializable; Postgres defaults to read
  committed. Code that depends on the distinction needs to know which engine it is on.
- **Everything outside the query shape.** Full-text search, window functions, arrays, and
  extensions are all deliberately outside this interface. Use the driver directly for
  those, in one clearly marked place.

## Adapters and conformance

Both adapters run one shared test suite, exported as `repolayer/testing`. That is what
turns "the two backends behave identically" from a hope into something checked on every
commit, and it is available to third-party adapters too:

```ts
import { runConformanceSuite } from 'repolayer/testing';

runConformanceSuite({
  name: 'my-engine',
  async createRepo(options) { /* fresh, isolated table per test */ },
  async cleanup() { /* ... */ },
});
```

## Development

```bash
npm run build       # ESM + CJS + type declarations
npm run typecheck   # tsc --noEmit
npm test            # unit tests plus the SQLite conformance suite, no setup needed
npm run test:pg     # starts Postgres in docker compose and runs the full suite
npm run example:swap  # runs the same logic on both drivers and diffs the output
```

`npm test` runs everything that needs no external service. The Postgres conformance tests
skip with a message unless `TEST_DATABASE_URL` is set.

## License

MIT
