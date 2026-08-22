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

## What this is not

Not an ORM. There is no query builder DSL to learn, no migration engine, no relationship
mapping, and no lazy-loading magic. It is a deliberately boring contract: a `Repo<T>`
interface with predictable methods, a small serializable query shape, and four adapters
that satisfy it identically.

The filter language is kept small on purpose. Most ORMs leak the moment you need something
dialect specific; a restricted query shape is what lets two very different engines behave
the same way, and it is why the abstraction can hold.

## Install

```bash
npm install repolayer
npm install pg       # only for the Postgres driver
npm install mysql2   # only for the MySQL or MariaDB driver
```

Both are optional peer dependencies, imported lazily, so a project on one engine never
loads the other one's driver and does not need it installed.

| driver | engine | needs |
|---|---|---|
| `sqlite` | SQLite, through `node:sqlite` | nothing |
| `postgres` | PostgreSQL | `pg` |
| `mysql` | MySQL **and** MariaDB | `mysql2` |
| (none) | `MemoryRepo`, for tests | nothing |

Requires Node 22.5 or newer. `node:sqlite` is stable on Node 24+, unflagged on 23.4+, and
needs `--experimental-sqlite` on 22.5 through 23.3. The other engines have no such
constraint.

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
await repo.updateMany({ where: { solved: false } }, { difficulty: 1 });   // -> how many
await repo.delete(puzzle.id);
await repo.deleteMany({ where: { solved: true } });

for await (const puzzle of repo.stream({ where: { solved: false } })) { /* batched */ }
await repo.findPage({ orderBy: [{ field: 'createdAt', direction: 'desc' }] }, { limit: 20 });
```

`where` also accepts an object, read as an implicit AND of equality checks:
`{ where: { solved: false, difficulty: 5 } }`.

### Filter trees

An array of filters is an implicit AND. For anything else, group them. Groups nest, and the
whole thing stays plain JSON, so a filter can cross an HTTP boundary or sit in a config file
without a serializer.

```ts
await repo.findMany({
  where: [
    { field: 'solved', op: 'eq', value: false },        // AND
    {
      or: [
        { field: 'difficulty', op: 'gte', value: 8 },
        { and: [
          { field: 'tags', op: 'isNull', value: false },
          { field: 'title', op: 'ilike', value: 'sud%' },
        ] },
      ],
    },
  ],
});
```

Groups are always parenthesized in the generated SQL, so precedence cannot slip. An empty
`or` matches nothing and an empty `and` matches everything, which is the same convention an
empty `in` and `nin` already follow. Nesting is capped at 16 levels: a serializable filter
can arrive from a request, and an unbounded tree would compile to unbounded SQL.

### Streaming

`repo.stream()` pulls rows in batches instead of materializing the result, so a table larger
than memory can be exported, migrated, or re-indexed.

```ts
for await (const row of repo.stream({ where: { status: 'queued' } }, { batchSize: 500 })) {
  await handle(row);
}
```

It is a real server-side cursor on Postgres (`DECLARE` plus repeated `FETCH FORWARD`) and a
stepped statement on SQLite (`StatementSync.iterate()`). Both hold a resource for as long as
the loop runs, so the contract around leaving early is the important part:

- Leaving the loop with `break`, `return`, or a throw closes the cursor and ends the
  transaction it opened. Nothing leaks, and the suite asserts the pool returns to its
  baseline size after an early break.
- An iterable you never iterate never opens anything.
- Pass an `AbortSignal` to cancel from outside the loop. The signal's reason is what gets
  thrown, so a caller's own error object comes back out unchanged.
- To write inside the loop as part of the same transaction, stream from a transaction-bound
  repo: `repo.withTransaction(async (tx) => { for await (const row of tx.stream()) ... })`.

Two limits worth knowing. On SQLite a long-lived cursor holds a read lock, and on a
single-writer engine that blocks writers for its whole duration; mutating the table you are
streaming is unspecified, so write to a different one. On MySQL there is no server-side
cursor for a plain SELECT, so `stream` fetches the result and hands it out in batches: the
API is identical, but peak memory is not reduced there.

### Paging

`repo.findPage()` is keyset paging with an opaque cursor token. Unlike a stream it holds
nothing between calls, so the next page can be fetched by a different process minutes later.

```ts
const page = await repo.findPage(
  { orderBy: [{ field: 'createdAt', direction: 'desc' }] },
  { limit: 50, after: previousPage.cursor },
);
// { items: T[], cursor: string | null, hasMore: boolean }
```

The token encodes the sort-key values of the last row, and the next page compiles to a
keyset predicate rather than an `OFFSET`. That matters for two reasons: page 10,000 costs the
same as page 1, and rows inserted or deleted during the walk cannot shift a page underneath
you. `npm run example:paging-api` runs both approaches side by side against a table that is
being written to, and offset paging visibly repeats rows that keyset paging does not.

Three details the implementation insists on:

- **The sort is made total.** The primary key is appended as a final tiebreaker unless you
  already sorted by it. Without that, rows that tie on every sort key have no defined order,
  and a page boundary landing inside a tie skips one row and repeats another.
- **A token is only valid for the sort that produced it.** It carries a fingerprint of the
  `orderBy`, and using it under a different one throws rather than paging wrongly.
- **Tokens carry a version.** One minted by an older deployment fails loudly instead of
  being misread.

`findPage` rejects an `offset`, because mixing the two is always a mistake.

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

### Bulk writes

`deleteMany` and `updateMany` both take a filter and report how many rows matched.

```ts
await repo.updateMany({ where: { status: 'queued' } }, { status: 'running' });   // -> number
await repo.deleteMany({ where: [{ field: 'createdAt', op: 'lt', value: cutoff }] });
```

`updateMany` counts rows **matched**, not rows whose values actually changed, so setting a
field to the value it already holds still counts. The alternative would make the number
depend on the data rather than on the filter, and would make MySQL disagree with the others.

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

- **`like` case sensitivity.** SQLite's LIKE is case insensitive for ASCII by default,
  Postgres's is not, and MySQL's depends on the column's collation. The SQLite adapter sets
  `PRAGMA case_sensitive_like = ON` and the MySQL compiler forces a binary collation on the
  comparison, so `like` is case sensitive and `ilike` is not, everywhere.
- **NULL ordering.** Postgres sorts NULLs last on ASC; SQLite and MySQL sort them first.
  Every generated `ORDER BY` states the position explicitly, and since MySQL has no
  `NULLS LAST` syntax at all it compiles to an `ORDER BY (col IS NULL), col` prefix that
  produces the same order.
- **Storage types.** Booleans, dates, and JSON are stored differently on each engine and
  round trip through real `boolean`, `Date`, and parsed JSON values on all of them.
- **Constraint errors.** `SQLITE_CONSTRAINT_UNIQUE`, SQLSTATE `23505`, and MySQL error
  `1062` all become `UniqueConstraintError`, naming the same schema field.
- **`RETURNING`.** SQLite and Postgres have it, MySQL does not. On MySQL a `create` or
  `update` is a write plus a keyed read on one connection inside a transaction, so the
  return value is the same; it just costs a second statement.

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
- **Comparing a whole `json` value is textual, except on Postgres.** A json field is stored
  as the exact output of `JSON.stringify`, and `eq` and `ne` compare that text, so a filter
  has to be written the same shape it was stored in. Postgres compares `JSONB` structurally
  and so also matches the same document written with its keys in another order.

### MySQL and MariaDB specifics

One adapter serves both. It asks the server what it is at connect time and adjusts the two
things that genuinely differ between them, so `driver: 'mysql'` is correct for either.

- **Text columns must be utf8mb4.** `ensureTable` creates them as
  `utf8mb4 COLLATE utf8mb4_bin`, because the server default is a case-insensitive collation
  under which `=`, `in`, `unique`, and `ORDER BY` on text would all behave differently than
  on SQLite and Postgres. If your tables come from a migration tool, create string columns
  the same way: forcing a collation onto a latin1 column is an error rather than a
  comparison.
- **Reserved words.** Identifiers are never quoted, on any engine, so a column named `order`
  or `rank` will not work. Quoting them would change how Postgres folds case on existing
  tables, which is a worse trade than the limitation.
- **Driver options are set for you.** `FOUND_ROWS`, `jsonStrings`, `dateStrings`, and the
  big-number options are not preferences: each one exists to make a specific conformance
  case pass, and they are applied whether the pool is repolayer's or yours.
- **Dates are stored as UTC `DATETIME(6)`** and parsed back as UTC explicitly, so a
  timestamp does not shift when the server's timezone does.
- **`json` columns are `LONGTEXT`, not the native `JSON` type.** A native JSON column holds
  a normalized document, and MySQL does not match one against the text repolayer binds, so
  `eq` and `ne` on a json field would answer differently there than on MariaDB, SQLite, and
  `MemoryRepo`. MariaDB's `JSON` is a `LONGTEXT` alias already. If your tables come from a
  migration tool and use the native type, filtering a whole json value will not match; read
  the field and compare it in application code instead.

## Testing without a database

`MemoryRepo` is a full `Repo<T>` that keeps everything in memory. It needs no driver, no
file, and no cleanup, which makes it a good target for unit tests of code written against
`Repo<T>`.

```ts
import { MemoryRepo } from 'repolayer/memory';

const repo = new MemoryRepo<Order>({ table: 'orders', schema: orderSchema });
const service = new OrderService(repo);
```

It is trustworthy for one reason only: it passes the same conformance suite as the real
adapters. Filters, null ordering, `like` case sensitivity, unique constraints, transactions
and savepoints, streaming, and keyset paging all behave the way a real engine behaves,
because the suite fails if they do not. A fake that quietly diverges is worse than no fake,
since the tests it passes stop meaning anything.

What it does not model, and does not pretend to: isolation levels, concurrent writers, and
anything about how a real engine schedules work. Use it to test your logic, not your
database. `npm run example:memory-testing` shows a service tested end to end this way.

## Adapters and conformance

Every adapter runs one shared test suite, exported as `repolayer/testing`. That is what
turns "the backends behave identically" from a hope into something checked on every commit,
and it is available to third-party adapters too:

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
npm run lint        # eslint + prettier --check
npm test            # unit tests, plus SQLite and MemoryRepo conformance. No setup needed.
npm run bench       # benchmarks, compared against bench/BASELINE.md

npm run test:pg       # starts Postgres in docker compose and runs the full suite
npm run test:mysql    # the same, against MySQL
npm run test:mariadb  # the same, against MariaDB
npm run test:all      # every engine at once
npm run db:down       # stops them and removes the volumes

npm run example:swap            # the same logic on every engine, output diffed
npm run example:stream-export   # cursors, early exit, and cancellation
npm run example:paging-api      # keyset paging against offset paging, under writes
npm run example:memory-testing  # a service unit-tested with no database
```

`npm test` runs everything that needs no external service, which is the unit tests plus two
full conformance runs: SQLite and `MemoryRepo`. The Postgres, MySQL, and MariaDB suites skip
with a message unless their `TEST_*_URL` is set.

CI always sets all three, against service containers, and then reads the test report back
and fails the build if any engine's suite skipped instead of running. "Passing" can never
quietly mean SQLite only. The `test:*` scripts start the containers for you, or point at a
server you already have by exporting the variable yourself; without Docker they say so
rather than failing obscurely.

## Releasing

Publishing is automated. Do not run `npm publish` by hand.

1. Bump the version and commit it: `npm version patch` (or `minor` / `major`), which also
   creates the matching `vX.Y.Z` tag.
2. Push the commit and the tag: `git push --follow-tags`.

Pushing the tag, or publishing a GitHub Release, triggers `.github/workflows/publish.yml`.
It runs the full CI suite including the Postgres conformance tests, checks the tag against
`package.json`, and only then publishes with `npm publish --provenance`. The provenance
attestation is what produces the verified build-source badge on the npm page: it links the
published tarball to this repository, this commit, and the workflow that built it.

Authentication uses npm **trusted publishing**, so there is no `NPM_TOKEN` secret in this
repository. npm mints a short-lived, single-publish credential from the workflow's OIDC
identity. This depends on a Trusted Publisher configured on the npm package page
(Settings tab, or `npmjs.com/package/repolayer/access`) naming this repository and the
`publish.yml` workflow file. **Renaming that workflow file breaks the match** and publishes
will start failing until the npm-side configuration is updated to match.

Doing both (pushing a tag and cutting a Release from it) is safe. The second run notices
the version is already on npm and exits without republishing.

## License

MIT
