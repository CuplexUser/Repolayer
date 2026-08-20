# Roadmap

What is shipped, what is coming, and what is deliberately never coming. Items are listed
in the order they are expected to land.

## v1.0, shipped

The `Repo<T>` interface, `QueryOptions` with the eleven operators, the schema descriptor,
SQLite and Postgres adapters, transactions with savepoints, `ensureTable()`, id and
timestamp strategies, and the shared conformance suite that both adapters pass.

## v1.1, cursors

The one substantial capability deliberately deferred out of v1. "Cursor" covers both
senses the package needs, and they share a design, so they ship together.

### Streaming cursors: `repo.stream(query)`

Returns an `AsyncIterable<T>` that pulls rows in batches instead of materializing the whole
result set, so a table larger than memory can be exported, migrated, or re-indexed.

```ts
for await (const row of repo.stream({ where: { status: 'queued' } })) {
  await handle(row);
}
```

Per engine:

- **Postgres**: a real server-side cursor. `DECLARE ... CURSOR` inside a transaction, then
  repeated `FETCH FORWARD n`, using `pg-cursor` when it is installed and a hand-rolled
  DECLARE/FETCH otherwise. Rows never all arrive at the client, which is the entire point.
- **SQLite**: `StatementSync.iterate()` from `node:sqlite`, which steps the statement row by
  row, yielded in batches so the async interface does not pay a microtask per row.

The hard part, and the reason this is not in v1, is **resource lifetime**. A cursor holds
an open transaction on Postgres and a read lock on SQLite, so the contract has to be
airtight:

- A consumer `break`, `return`, or `throw` inside `for await` must close the cursor and end
  the transaction. That means implementing `AsyncIterator.return()`, not just `next()`.
- An abandoned iterator must not leak a pooled Postgres client. The suite asserts the pool
  returns to its baseline size after an early break.
- Writes performed inside the loop must be able to join the cursor's own transaction, so
  `stream` exposes the same `TxContext` that `withTransaction` does.
- Long-running cursors interact badly with SQLite's single-writer model. Holding one open
  across slow work blocks writers, and the docs will say so plainly.
- An `AbortSignal` option, so a cursor can be cancelled from outside the loop.

### Keyset pagination cursors: `repo.findPage(query, opts)`

An opaque, stateless cursor token for API-style paging. Unlike the streaming cursor it
holds no connection between requests.

```ts
const page = await repo.findPage(
  { orderBy: [{ field: 'createdAt', direction: 'desc' }] },
  { limit: 50, after: previousPage.cursor },
);
// { items: T[], cursor: string | null, hasMore: boolean }
```

The token encodes the sort-key values of the last row, and the next page compiles to a
keyset predicate in row-comparison form rather than `OFFSET`, so paging stays correct and
fast as rows are inserted underneath it. Deferred from v1 because correctness across
mixed-direction sorts and nullable sort keys is genuinely fiddly, and it depends on the
explicit `NULLS FIRST` / `NULLS LAST` normalization v1 establishes. Tokens carry a version
tag so a token from an older deployment fails loudly instead of silently paging wrong.

### Conformance additions

Both cursor forms get suite cases that must pass identically on every driver: a full
traversal yields exactly `findMany()` in the same order, `batchSize` does not affect
results, an early break closes cleanly and leaks no connection, a concurrent insert during
traversal neither duplicates nor skips already-returned rows under keyset paging, empty
result sets terminate immediately, and `findPage` walked to exhaustion reconstructs the
full ordered set with no gaps or repeats.

## v1.2, ergonomics

- `OR` groups and nested filter trees in `QueryOptions`, kept serializable.
- A `MemoryRepo` in `repolayer/testing` that also passes the conformance suite, for unit
  tests with no database at all.
- `updateMany` taking a `QueryOptions` predicate, to match `deleteMany`.

## v2.0, more engines

Adding an engine is the real test of whether the abstraction holds, because the conformance
suite is the contract and a new adapter either passes it or does not. Two are planned, in
this order.

### MySQL and MariaDB (`mysql2`)

The closer port, since it is another SQL dialect behind the same compiler. Almost all the
work lands in the normalization layer v1 already established:

- Placeholders are `?`, as in SQLite, so the compiler needs no third placeholder style.
- `RETURNING` does not exist, so `create` and `update` become an INSERT or UPDATE followed
  by a keyed SELECT on the same connection, inside a transaction where one is not already
  open.
- Collation decides `LIKE` case sensitivity, so `like` must force a binary collation and
  `ilike` a case-insensitive one, rather than trusting the server or table default. Same
  class of problem as SQLite's `case_sensitive_like` pragma, solved in the same place.
- There is no `NULLS FIRST` / `NULLS LAST` syntax, so ordering compiles to an
  `ORDER BY (col IS NULL) ASC|DESC, col` prefix to reproduce the normalized position.
- `boolean` is `TINYINT(1)`, `date` is `DATETIME(6)` written explicitly in UTC, and `json`
  is the native `JSON` type.
- Unique violations arrive as error `1062`, mapped to `UniqueConstraintError`.

### MongoDB (`mongodb`)

The more interesting one, and the one that proves restricting the query shape was worth
it. `QueryOptions` maps almost directly onto a Mongo `find`, with no SQL involved:
`eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`in`/`nin` are already the `$` operator names, `orderBy`
becomes `sort`, and `limit`/`offset` become `limit`/`skip`. That the same interface
compiles to both SQL and a document query without widening is the strongest available
evidence this is not just a SQL builder wearing a disguise.

Where it genuinely differs, and how each is handled:

- `like` and `ilike` compile to anchored `$regex`, with `%` and `_` translated to `.*` and
  `.`, and every other regex metacharacter escaped. Anything less would let a filter value
  become executable, which is the injection problem in a different costume.
- The primary key maps to `_id`, projected back to the schema's declared field on read and
  written on create, so application code keeps seeing `id`.
- `unique: true` becomes a unique index created by `ensureCollection()`, the counterpart of
  `ensureTable()`. Duplicate key error `11000` maps to `UniqueConstraintError`.
- **Transactions require a replica set or a sharded cluster** and are simply unavailable on
  a standalone `mongod`. This will not be papered over: `withTransaction` throws a clear
  `ConnectionError` explaining the requirement rather than silently running without
  atomicity. The suite already supports declaring a capability unsupported with a stated
  reason, so this becomes documented behavior rather than a quiet skip.
- Null ordering, decimal precision, and the absence of a fixed schema are all pinned down
  by the existing type round-trip cases, which is exactly why those cases assert on values
  rather than on generated SQL.

If the Mongo adapter cannot pass the suite without loosening it, that is a finding worth
publishing, not a reason to loosen the suite.

## Later

- Further adapters: Cloudflare D1, libSQL/Turso, and an HTTP adapter, once the suite is
  proven to be a sufficient contract for adapters written by other people.

## Never

- **Relations, eager loading, and a query builder DSL.** These are the ORM features this
  package exists to avoid. Use an ORM if you want them; that is a legitimate choice, just a
  different one.
- **A migration engine.** Pair repolayer with `node-pg-migrate` or a SQL-file runner. See
  the README.
- **Raw SQL passthrough on the `Repo` interface.** Dialect-specific SQL is fine and
  sometimes necessary, but it belongs in one clearly marked place using the driver
  directly, not smuggled through an interface whose entire promise is that both engines
  behave the same.
