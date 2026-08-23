# Roadmap

What is shipped, what is coming, and what is deliberately never coming.

## Versioning

Everything under "Shipped" lands in `1.0.0`, the first stable release. Earlier drafts of
this file numbered the milestones `v1.0`, `v1.1` and so on, which read as released versions
that did not exist on npm, so the milestones are named by what they contain instead.

`1.0.0` is a major bump rather than a minor one because `Repo<T>` grew three methods,
`stream`, `findPage`, and `updateMany`, and `Dialect` grew two members. Neither breaks
application code, but both break any third-party adapter that implements the interface
directly, and the whole premise of the conformance suite is that such adapters exist.

## Shipped

### The contract

The `Repo<T>` interface, `QueryOptions` with the eleven operators, the schema descriptor,
transactions with savepoints, `ensureTable()`, id and timestamp strategies, and the shared
conformance suite that every adapter passes.

### Adapters

SQLite (`node:sqlite`), Postgres (`pg`), MySQL and MariaDB (`mysql2`), and an in-memory
`MemoryRepo`. All four pass the same suite, which is the only reason the claim that they
behave identically means anything.

### Cursors

Both senses the package needs, sharing one design.

**`repo.stream(query, opts)`** returns an `AsyncIterable<T>` that pulls rows in batches
rather than materializing the result set. A real server-side cursor on Postgres
(`DECLARE` plus repeated `FETCH FORWARD`), a stepped statement on SQLite
(`StatementSync.iterate()`), and a batched replay on MySQL, which has no server-side cursor
for a plain SELECT.

The hard part, and the reason it was deferred out of the first release, was resource
lifetime rather than iteration. What the contract now guarantees:

- A consumer `break`, `return`, or `throw` closes the cursor and ends the transaction it
  opened, because every adapter implements it as an async generator whose `finally` does
  the closing.
- An abandoned iterator does not leak a pooled Postgres client. The suite asserts the pool
  returns to its baseline after an early break, through an optional `busyConnections()`
  hook an adapter can provide.
- Writes performed inside the loop join the cursor's transaction, by streaming from a
  transaction-bound repo. No second API was needed for this.
- An `AbortSignal` cancels from outside the loop, throwing the reason the caller gave.
- Long-running cursors interact badly with SQLite's single-writer model, and the docs say
  so plainly rather than implying otherwise.

**`repo.findPage(query, opts)`** is keyset pagination with an opaque, stateless token. The
token encodes the sort-key values of the last row, and the next page compiles to a keyset
predicate rather than an `OFFSET`, so paging stays correct as rows are inserted underneath
it and stays fast at any depth. Tokens carry a version tag and a fingerprint of the sort
they were minted under, so a stale or mismatched token fails loudly instead of silently
paging wrong.

Deviation from the original plan: **`pg-cursor` is not used**, even optionally. The
hand-rolled DECLARE/FETCH path has to exist and be tested regardless, and a second optional
peer dependency would have bought a code path exercised only on the machines that happen to
have it installed.

### Ergonomics

- `OR` groups and nested filter trees in `QueryOptions`, still plain serializable JSON,
  with a depth cap so a filter arriving from a request cannot compile to unbounded SQL.
- `updateMany` taking a `QueryOptions` predicate, to match `deleteMany`. It reports rows
  matched rather than rows changed, so the number depends on the filter rather than on the
  data.
- `MemoryRepo`, exported from `repolayer/memory`, for unit tests with no database at all.
  It passes the conformance suite, which is what separates it from a fake that quietly
  diverges.

### MySQL and MariaDB, in detail

One dialect, with the flavor detected at connect. Almost all of the work landed in the
normalization layer that already existed:

- Placeholders are `?`, as in SQLite, so the compiler needed no third placeholder style.
- `RETURNING` does not exist, so `create` and `update` are an INSERT or UPDATE followed by
  a keyed SELECT on the same connection, inside a transaction where one is not already
  open. `BaseRepo` owns that choreography behind a `supportsReturning` flag, so the two
  paths cannot drift apart.
- Collation decides `LIKE` case sensitivity, so `like` forces a binary collation and
  `ilike` lowers both sides, rather than trusting the server or table default. Same class
  of problem as SQLite's `case_sensitive_like` pragma, solved in the same place.
- There is no `NULLS FIRST` / `NULLS LAST` syntax, so ordering compiles to an
  `ORDER BY (col IS NULL) ASC|DESC, col` prefix that reproduces the normalized position.
- `boolean` is `TINYINT(1)`, `date` is `DATETIME(6)` written explicitly in UTC, and `json`
  is the native `JSON` type, read as raw text on both flavors so one parse path serves
  both.
- Unique violations arrive as error `1062`, in two different message shapes, mapped to
  `UniqueConstraintError` naming the schema field.

## Next

### MongoDB (`mongodb`)

The interesting one, and the one that would prove restricting the query shape was worth it.
`QueryOptions` maps almost directly onto a Mongo `find`, with no SQL involved:
`eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`in`/`nin` are already the `$` operator names, `orderBy`
becomes `sort`, and `limit`/`offset` become `limit`/`skip`.

`MemoryRepo` has since made a weaker version of that argument already, by satisfying the
same interface with no SQL anywhere. Mongo would make it against a real engine.

Where it genuinely differs, and how each would be handled:

- `like` and `ilike` compile to anchored `$regex`, with `%` and `_` translated to `.*` and
  `.`, and every other regex metacharacter escaped. Anything less would let a filter value
  become executable, which is the injection problem in a different costume. `MemoryRepo`
  already does exactly this translation, so the logic exists.
- The primary key maps to `_id`, projected back to the schema's declared field on read and
  written on create, so application code keeps seeing `id`.
- `unique: true` becomes a unique index created by `ensureCollection()`, the counterpart of
  `ensureTable()`. Duplicate key error `11000` maps to `UniqueConstraintError`.
- **Transactions require a replica set or a sharded cluster** and are simply unavailable on
  a standalone `mongod`. This will not be papered over: `withTransaction` throws a clear
  `ConnectionError` explaining the requirement rather than silently running without
  atomicity. The suite already supports declaring a capability unsupported with a stated
  reason, so this becomes documented behavior rather than a quiet skip.
- Keyset paging needs the same lexicographic expansion the SQL adapters use, which now
  lives in `src/core/keyset.ts` and is engine-independent, so it should port unchanged.
- Null ordering, decimal precision, and the absence of a fixed schema are all pinned down
  by the existing type round-trip cases, which is exactly why those cases assert on values
  rather than on generated SQL.

If the Mongo adapter cannot pass the suite without loosening it, that is a finding worth
publishing, not a reason to loosen the suite.

## Later

- Further adapters: Cloudflare D1, libSQL/Turso, and an HTTP adapter, once the suite is
  proven to be a sufficient contract for adapters written by other people.
- A server-side streaming path for MySQL. `mysql2` can stream, but only through its
  callback API, and wiring that up means a second cursor lifetime to get right. Today
  `stream` is correct there but does not reduce peak memory, and that is documented.

## Never

- **Relations, eager loading, and a query builder DSL.** These are the ORM features this
  package exists to avoid. Use an ORM if you want them; that is a legitimate choice, just a
  different one.
- **A migration engine.** Pair repolayer with `node-pg-migrate` or a SQL-file runner. See
  [`ensureTable()`](docs/api.md#ensuretable).
- **Raw SQL passthrough on the `Repo` interface.** Dialect-specific SQL is fine and
  sometimes necessary, but it belongs in one clearly marked place using the driver
  directly, not smuggled through an interface whose entire promise is that every engine
  behaves the same.
- **Quoted identifiers.** They would allow reserved words as column names, but Postgres
  folds unquoted identifiers to lowercase, so quoting them would make `createdAt` refer to
  a different column than every existing table has. A documented limitation beats a silent
  break.
