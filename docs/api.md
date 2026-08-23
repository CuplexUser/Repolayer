# API

Everything in the package, in one place. The interface is small on purpose: a `Repo<T>`
with predictable methods, a serializable query shape, and four adapters that satisfy it
identically.

- [`createRepo(config)`](#createrepoconfig) - build a repo for one table on one engine
- [`defineSchema(fields)`](#defineschemafields) - describe a table's columns and types
- [`Infer<typeof schema>`](#infertypeof-schema) - the row type a schema describes
- [`Repo<T, ID>`](#repot-id) - the contract every adapter implements
  - [`.findById(id)`](#findbyidid)
  - [`.findOne([query])`](#findonequery)
  - [`.findMany([query])`](#findmanyquery)
  - [`.count([query])`](#countquery)
  - [`.stream([query], [options])`](#streamquery-options)
  - [`.findPage([query], [options])`](#findpagequery-options)
  - [`.create(data)`](#createdata)
  - [`.createMany(records)`](#createmanyrecords)
  - [`.update(id, data)`](#updateid-data)
  - [`.updateMany(query, data)`](#updatemanyquery-data)
  - [`.delete(id)`](#deleteid)
  - [`.deleteMany([query])`](#deletemanyquery)
  - [`.withTransaction(fn)`](#withtransactionfn)
  - [`.with(ctx)`](#withctx)
  - [`.ensureTable()`](#ensuretable)
  - [`.close()`](#close)
  - [properties](#properties)
- [Errors](#errors)
- [`MemoryRepo`](#memoryrepo)
- [Lower level exports](#lower-level-exports)

The query shape that `findMany`, `count`, `stream`, `updateMany`, and the rest all accept is
documented separately, in [queries.md](queries.md).

## `createRepo(config)`

```ts
function createRepo<T, ID = string>(config: CreateRepoConfig<T>): Promise<Repo<T, ID>>;
```

The one call site that decides which engine you are on. Everything downstream talks to
`Repo<T>` and cannot tell the difference, which is the entire point of the package: moving
from SQLite to Postgres is a change to this config, not to your queries.

```ts
import { createRepo } from 'repolayer';

const repo = await createRepo<Puzzle>({
  driver: 'sqlite',
  table: 'puzzles',
  schema: puzzleSchema,
  connection: { file: './data.db' },
  ids: 'uuid',
  timestamps: true,
  ensureTable: true,
});
```

| option | type | meaning |
|---|---|---|
| `driver` | `'sqlite'`, `'postgres'`, `'mysql'` | which adapter to load. `'mysql'` covers MariaDB too |
| `table` | `string` | the table this repo reads and writes |
| `schema` | `Schema` | from [`defineSchema`](#defineschemafields) |
| `connection` | see below | per driver connection settings, or a pool you already own |
| `ids` | `'uuid'`, `'autoincrement'`, `'provided'` | how `create` produces a primary key. Defaults to `'uuid'` |
| `timestamps` | `boolean` or `{ createdAt?, updatedAt? }` | maintain created and updated fields. Defaults to off |
| `ensureTable` | `boolean` | run [`ensureTable()`](#ensuretable) before returning |

The adapter module is imported lazily, so a SQLite-only project never loads `pg` and does
not need it installed. An unknown `driver` throws `ConnectionError`.

### Connections

```ts
{ driver: 'sqlite',   connection: { file: './data.db', busyTimeoutMs: 5000 } }
{ driver: 'postgres', connection: { connectionString: 'postgres://...', max: 10 } }
{ driver: 'mysql',    connection: { connectionString: 'mysql://...',    max: 10 } }
```

Each driver also accepts something you already own, so repolayer can share a connection with
the rest of an application: a `SqliteConnection` from `openSqlite()`, a `pg` pool, or a
`mysql2` pool. Repos pointed at the same SQLite file share one connection automatically,
because SQLite allows a single writer and because [`repo.with(ctx)`](#withctx) between two
repos would otherwise be impossible.

`close()` ends a pool that repolayer created, and leaves one you passed in alone.

### Ids

`'uuid'`, the default, generates a `crypto.randomUUID()` and needs a `string` primary key.
`'autoincrement'` leaves the key to the engine and needs an `integer` primary key.
`'provided'` means you set it yourself on every `create`. A mismatch between the strategy and
the declared primary key type throws at construction time rather than on the first write.

### Timestamps

`timestamps: true` maintains the conventional `createdAt` and `updatedAt` fields; pass an
object such as `{ createdAt: 'created', updatedAt: false }` to rename or disable either. Both
values are set in JavaScript rather than by database defaults, so every engine produces the
same value at the same precision.

## `defineSchema(fields)`

```ts
function defineSchema<const F extends FieldMap>(fields: F): Schema<F>;
```

The schema descriptor is a plain object. No validator library, no peer dependency. It tells
the adapters how to name columns, how to serialize each type, and how to generate DDL for
local development.

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
```

| field property | meaning |
|---|---|
| `type` | `'string'`, `'number'`, `'integer'`, `'boolean'`, `'date'`, or `'json'` |
| `column` | column name in the database. Defaults to the field name |
| `primaryKey` | marks the single primary key. Exactly one field must have it |
| `nullable` | allows null, and widens the inferred type |
| `unique` | adds a unique constraint to the generated DDL |
| `default` | a DDL default applied by `ensureTable()`, not applied client side |

Anything more exotic than the six types belongs in a `json` field rather than in a
dialect-specific column type.

Validation happens once, at definition time, so a malformed schema fails at module load
rather than on a customer's first request. `defineSchema` throws `SchemaError` for an unknown
type, no fields at all, two primary keys, a nullable primary key, two fields mapped onto one
column, or a column name that is not a plain identifier. That last rule exists because
repolayer never quotes identifiers, which also means a column cannot be named after a
reserved word such as `order`.

## `Infer<typeof schema>`

```ts
type Puzzle = Infer<typeof puzzleSchema>;
// { id: string; title: string; difficulty: number; solved: boolean;
//   tags: unknown | null; solvedAt: Date | null; createdAt: Date; ... }
```

`string`, `number` and `integer`, `boolean`, and `date` map to `string`, `number`, `boolean`,
and `Date`. A `json` field is `unknown`, so the compiler makes you narrow it. Fields declared
`nullable: true` widen to include `null`, which is what tells you where absent values have to
be handled.

`CreateInput<T>` is the matching insert shape: the primary key is optional there, because the
adapter generates it under the `uuid` and `autoincrement` strategies.

## `Repo<T, ID>`

The whole contract. Every adapter implements exactly this, and the conformance suite tests
exactly this, so a third-party adapter that passes the suite is a drop-in. `T` is the row
type and `ID` the primary key type, which defaults to `string`.

### `.findById(id)`

```ts
findById(id: ID): Promise<T | null>;
```

One row by primary key, or `null`. Does not throw when the row is absent.

### `.findOne([query])`

```ts
findOne(query?: QueryOptions<T>): Promise<T | null>;
```

The first row matching the query, or `null`. It applies the query's `orderBy` and then takes
one row, so an unordered `findOne` returns an arbitrary match rather than a defined one.

### `.findMany([query])`

```ts
findMany(query?: QueryOptions<T>): Promise<T[]>;
```

Every matching row, materialized into an array. Omitting the query reads the whole table,
which is fine for a small one and is what [`stream`](#streamquery-options) exists to avoid
for a large one.

```ts
await repo.findMany({
  where: [
    { field: 'solved', op: 'eq', value: false },
    { field: 'title',  op: 'ilike', value: 'sud%' },
  ],
  orderBy: [{ field: 'createdAt', direction: 'desc' }],
  limit: 20,
  offset: 40,
});
```

### `.count([query])`

```ts
count(query?: QueryOptions<T>): Promise<number>;
```

How many rows match. `orderBy`, `limit`, and `offset` are ignored, since none of them change
a count.

### `.stream([query], [options])`

```ts
stream(query?: QueryOptions<T>, opts?: StreamOptions): AsyncIterable<T>;
// StreamOptions: { batchSize?: number; signal?: AbortSignal }
```

Pulls rows in batches instead of materializing the result, so a table larger than memory can
be exported, migrated, or re-indexed. `batchSize` defaults to 100, and never changes which
rows come back or in what order.

The cursor holds a resource for as long as the loop runs, so the rules about leaving early,
cancelling, and writing from inside the loop are the part worth reading:
[streaming.md](streaming.md).

### `.findPage([query], [options])`

```ts
findPage(query?: QueryOptions<T>, opts?: PageOptions): Promise<Page<T>>;
// PageOptions: { limit?: number; after?: string | null }
// Page<T>:     { items: T[]; cursor: string | null; hasMore: boolean }
```

Keyset pagination with an opaque cursor token. `limit` defaults to 50. Unlike a stream it
holds nothing between calls, so the next page can be fetched by a different process minutes
later. Passing an `offset` is rejected, because mixing the two is always a mistake. See
[streaming.md](streaming.md#paging) for what the token carries and why the sort is made
total.

### `.create(data)`

```ts
create(data: Partial<T>): Promise<T>;
```

Inserts one row and returns it as stored, including the generated id and timestamps. A unique
constraint rejection becomes [`UniqueConstraintError`](#errors).

### `.createMany(records)`

```ts
createMany(data: Partial<T>[]): Promise<T[]>;
```

Inserts many rows in one statement and returns them in the order given. Every record has to
set the same fields as the first one, which is what lets the insert stay a single statement;
a record missing a field that record 0 sets throws `QueryError`.

### `.update(id, data)`

```ts
update(id: ID, data: Partial<T>): Promise<T>;
```

Applies a partial change to one row and returns the updated row. Throws
[`NotFoundError`](#errors) when no row has that id. Refreshes `updatedAt` when timestamps are
on.

### `.updateMany(query, data)`

```ts
updateMany(query: QueryOptions<T> | undefined, data: Partial<T>): Promise<number>;
```

Applies one change to every matching row and returns how many **matched**, not how many had a
value actually change, so setting a field to the value it already holds still counts. The
alternative would make the number depend on the data rather than on the filter, and would
make MySQL disagree with the other engines.

```ts
await repo.updateMany({ where: { status: 'queued' } }, { status: 'running' });
```

### `.delete(id)`

```ts
delete(id: ID): Promise<void>;
```

Removes one row. Throws [`NotFoundError`](#errors) when no row has that id.

### `.deleteMany([query])`

```ts
deleteMany(query?: QueryOptions<T>): Promise<number>;
```

Removes every matching row and returns how many were removed. Omitting the query empties the
table.

### `.withTransaction(fn)`

```ts
withTransaction<R>(fn: (repo: Repo<T, ID>, ctx: TxContext) => Promise<R>): Promise<R>;
```

Runs `fn` inside a transaction, handing it a transaction-bound view of the repo. Returning
commits, throwing rolls back.

```ts
await repo.withTransaction(async (tx) => {
  await tx.create({ /* ... */ });
  await tx.update(id, { /* ... */ });
});
```

Nested calls become savepoints rather than an error, so a function that opens a transaction
stays callable from inside one. To involve a second table, pass the context along with
[`with`](#withctx).

### `.with(ctx)`

```ts
with(ctx: TxContext): Repo<T, ID>;
```

Returns a view of this repo bound to an already-open transaction, which is how two repos on
different tables take part in one transaction.

```ts
await users.withTransaction(async (tx, ctx) => {
  const user = await tx.create({ /* ... */ });
  await orders.with(ctx).create({ userId: user.id });   // same connection, same transaction
});
```

Both repos have to share a connection, and binding a foreign one is rejected rather than
quietly running outside the transaction. Repos pointed at the same SQLite file share a
connection automatically; Postgres and MySQL repos need to be built from the same pool.

### `.ensureTable()`

```ts
ensureTable(): Promise<void>;
```

Generates `CREATE TABLE IF NOT EXISTS` from the schema, along with the unique indexes it
declares. A local-development and testing convenience, **not a migration engine**: it never
alters an existing table and will not notice drift.

Once a schema is in production, pair repolayer with a real migration tool such as
`node-pg-migrate` for Postgres or a small SQL-file runner for SQLite. Keeping migrations out
is what keeps this package small. If your tables come from a migration tool, note the
[column requirements on MySQL](engines.md#mysql-and-mariadb-specifics).

### `.close()`

```ts
close(): Promise<void>;
```

Releases the underlying connection or pool, when this repo owns it. A pool you passed in
yourself is left for you to close.

### Properties

| property | type | meaning |
|---|---|---|
| `.table` | `string` | the table name |
| `.schema` | `Schema` | the descriptor this repo was built with |
| `.dialect` | `'sqlite'`, `'postgres'`, `'mysql'` | which engine is underneath |

`.dialect` exists for the rare branch that genuinely has to know, such as a startup check or
a log line. Reaching for it in ordinary query code means the abstraction is being worked
around.

## Errors

Every adapter maps its driver's failures onto the same types, so you can branch on them
without knowing which engine is underneath.

```ts
import { NotFoundError, UniqueConstraintError, QueryError } from 'repolayer';

try {
  await repo.create({ slug: 'taken', /* ... */ });
} catch (error) {
  if (error instanceof UniqueConstraintError) {
    console.log(error.fields);   // ['slug'] on every engine that names them
  }
}
```

| error | thrown when | carries |
|---|---|---|
| `RepoError` | the base class of all the others | `message`, `cause` |
| `NotFoundError` | `update` or `delete` finds no row with that id | `table`, `id` |
| `UniqueConstraintError` | a unique constraint or primary key rejects a write | `table`, `fields` |
| `QueryError` | a query cannot be compiled: unknown field, bad operator, malformed value | |
| `ConnectionError` | a connection could not be opened, borrowed, or used | |
| `SchemaError` | the schema descriptor itself is invalid | |

`QueryError` is always thrown before any SQL reaches the database.
`SQLITE_CONSTRAINT_UNIQUE`, SQLSTATE `23505`, and MySQL error `1062` all become
`UniqueConstraintError` naming the same schema field.

## `MemoryRepo`

```ts
import { MemoryRepo } from 'repolayer/memory';

const repo = new MemoryRepo<Order>({ table: 'orders', schema: orderSchema });
```

A full `Repo<T>` that keeps everything in memory, for unit tests that should not need a
database. Options are `table`, `schema`, `ids`, `timestamps`, and a `store` shared between
repos so they can take part in one transaction. See [testing.md](testing.md).

## Lower level exports

The pieces the adapters are built from are exported too, for anyone writing an adapter or a
tool around the query shape. They are stable, but they are not the API most code should
reach for.

| export | what it is |
|---|---|
| `BaseRepo` | the shared adapter base class, holding query compilation and the write paths |
| `compileSelect`, `compileCount`, `compileWhere`, `compileOrderBy`, `compileLimit` | the SQL compiler, one function per clause |
| `normalizeWhere`, `selectList`, `ParamList` | the helpers those functions are written in terms of |
| `createTableStatements`, `dropTableStatement` | DDL generation |
| `encodeCursor`, `decodeCursor`, `keysetFilter`, `resolveSortKeys` | the keyset paging primitives |
| `toDb`, `fromDb`, `rowToEntity` | per-type serialization between JavaScript and each engine |
| `columnFor` | field name to column name for a schema |

The adapter subpaths `repolayer/sqlite`, `repolayer/postgres`, and `repolayer/mysql` each
export their repo class, their connection class, and a `create*Repo` function, for building
an adapter directly instead of through `createRepo`.
