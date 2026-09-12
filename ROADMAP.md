# Roadmap

What is shipped, what is coming, and what is deliberately never coming.

## Versioning

Everything under "Shipped" lands in `1.0.0`, the first stable release. Earlier drafts of
this file numbered the milestones `v1.0`, `v1.1` and so on, which read as released versions
that did not exist on npm, so the milestones are named by what they contain instead.

The rule for a major bump is not "`Repo<T>` grew a method". It is that an existing adapter
can no longer compile without being rewritten, which happens when `BaseRepo` grows an
abstract member or an existing signature changes. Application code has never been broken by
a release and that is not what these bumps are about; the conformance suite exists on the
premise that third-party adapters exist, so their compatibility is what the version number
tracks.

`1.0.0` is a major bump under that rule: `Repo<T>` grew `stream`, `findPage`, and
`updateMany`, `Dialect` grew two members, and `BaseRepo` grew an abstract `openCursor()`
that every adapter had to write for itself.

Drift detection lands in `2.0.0` for the same reason. `Repo<T>` grew `verifyTable()` and
`BaseRepo` grew an abstract `readTableShape()` hook, so every adapter had to supply a
catalog read before it would compile again.

Aggregation lands in `2.1.0`, and is a minor bump because it adds no abstract member.
`BaseRepo` implements `aggregate()` and `distinct()` in terms of the executor it already
has, so every adapter built on it gains both methods and compiles untouched. Only an
adapter that implements the bare `Repo<T>` interface from scratch has to add them, which is
what `MemoryRepo` did here.

Binary data and the type rules land in `2.2.0`, a minor bump under the same rule: `BaseRepo`
grew no abstract member and no signature changed, so an adapter built on it compiles
untouched and gains `binary` through `toDb` and `fromDb`. Two things are worth knowing when
upgrading all the same. `FieldType` grew a member, so an exhaustive `switch` or a
`Record<FieldType, …>` in adapter code needs one new case. And a query that one engine
happened to answer, such as `like` on a date column on SQLite, now throws `QueryError`
everywhere, because another engine never answered it the same way. That query was never
portable; this release makes it fail on the engine you develop against instead of the one you
deploy to.

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

### Aggregation

`repo.aggregate()` groups rows and reduces each group to the aggregates the caller names,
and `repo.distinct()` returns the distinct combinations of a few fields. Both stay inside
the serializable shape everything else uses: an aggregate is `{ fn, field, distinct }`
under an alias, `having` filters the groups the way `where` filters the rows, and nothing
in either is a fragment of SQL.

The interesting part was again what the engines disagree about, and each disagreement is
settled in the compiler rather than left to the caller:

- **`avg` is computed in double precision everywhere.** Postgres averages an integer column
  as `numeric` and answers with sixteen decimal places, MySQL answers with a four-place
  `DECIMAL`, and SQLite with a double. Three numbers for one question. Sums are left exact,
  since widening one would lose digits nobody asked to lose.
- **An aggregate over no values is null, and a count is zero.** An ungrouped aggregate over
  an empty table returns exactly one record, not none, on every engine and in `MemoryRepo`.
- **`having` repeats the aggregate expression** rather than naming the output alias, because
  Postgres accepts an alias in `GROUP BY` and `ORDER BY` but not in `HAVING`. It keeps a
  null group inside `ne`, for the same reason `ne` on a column keeps null rows.
- **What no engine could answer identically is refused**, with a `QueryError` explaining
  why: `min`/`max` over a `boolean` (Postgres has no `min(boolean)` at all) or over a
  `json` value, grouping or counting distinct on `json`, which only Postgres normalizes,
  and ordering a `distinct` read by a column it does not select, which Postgres rejects and
  SQLite answers with an arbitrary row per group.

Validation and name resolution live in `planAggregate`, which renders no SQL, so
`MemoryRepo` shares the rules rather than growing a second opinion about which queries are
legal. On MySQL, string grouping follows the column's collation: `ensureTable` creates
string columns `utf8mb4_bin` for exactly this reason, and `verifyTable()` reports a table
that was created some other way.

### Binary data and type rules

A `binary` field type, read and written as a `Uint8Array` on every engine: `BLOB` on SQLite,
`BYTEA` on Postgres, `LONGBLOB` on MySQL, or `VARBINARY(255)` where it is unique. pg and mysql2
hand back a `Buffer`, and it is returned as a plain `Uint8Array` over the same memory, so a
row read from one engine compares equal to the same row read from another.

It supports equality and null checks only: `eq`, `ne`, `in`, `nin`, `isNull`, and `unique`.
That covers hashes, tokens, and stored files, and it is all the conformance suite proves so
far. A binary field cannot be the primary key or carry a DDL default.

Adding it surfaced a gap that had nothing to do with bytes: nothing checked an operator
against the type of the field it was applied to. `like` on an integer matched stored text on
SQLite and `MemoryRepo` and was a driver error on Postgres, and ordering a json field compared
`jsonb` documents on Postgres and text everywhere else. What each type allows now lives in
one table, `TYPE_RULES` in `src/core/rules.ts`, which the compiler, the aggregate planner,
keyset paging, and `MemoryRepo` all read, so none of them can grow a separate opinion.

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
  is `LONGTEXT` rather than the native `JSON` type. A native `JSON` column stores a
  normalized document, so comparing one against the exact text `toDb` produced does not
  match even when the document is the same, which would make `eq` and `ne` on a json field
  answer differently there than on SQLite, Postgres, and `MemoryRepo`. MariaDB's `JSON` is
  a `LONGTEXT` alias already, so this is what that flavor was doing regardless.
- Unique violations arrive as error `1062`, in two different message shapes, mapped to
  `UniqueConstraintError` naming the schema field.

### Drift detection

`repo.verifyTable()` reads the live table out of the engine's own catalog and reports where
it disagrees with the schema descriptor: a missing column, a type that will not round trip,
a nullability or primary key mismatch, a unique the schema declares and the table does not
carry.

This is the half of the story `ensureTable()` never told. Once a real migration tool owns
the table, nothing checked that the table it produced was the table the application queries
through, and the failure surfaced as a confusing runtime error or as silently wrong
behavior. Pairing repolayer with a migration tool was advice; now it is checkable.

It executes no DDL, proposes no `ALTER`, and keeps no version table. See
[Never](#never) below.

Two design points worth stating, because they are what keep it from being noise:

- **Three verdicts, not a boolean.** A table built by somebody else's tool may use a type
  repolayer never emits. An incompatible type is an error; a type repolayer has no opinion
  on is a warning that does not clear `ok`. Reporting is the job, not refusing.
- **Comparison lives in one pure function**, `diffTable` in `src/core/introspect.ts`. Each
  adapter only reads its own catalog into a normalized `TableShape`, so three engines cannot
  develop three opinions about what drift is, and the whole matrix is unit-testable with no
  database.

The highest-value single check is on MySQL. `ensureTable()` creates string columns
`utf8mb4_bin` on purpose, because the server default is case insensitive and would change
what `eq`, `in`, `unique`, and `ORDER BY` mean on that engine and no other. A table created
by anything else almost certainly used the default, and nothing caught it before.

`MemoryRepo` declares the `introspection` capability unsupported, with a reason: it has no
catalog, its store holds exactly what the schema describes, and a diff would have to be
invented.

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

- Ordering and grouping for `binary`. Every engine compares bytes the same way, byte by byte
  with a shorter prefix first, so range operators, `orderBy`, and `groupBy` look portable.
  They need conformance cases before the rule allows them, and `min`/`max` would stay refused
  because Postgres has no `min(bytea)`.
- Further adapters: Cloudflare D1, libSQL/Turso, and an HTTP adapter, once the suite is
  proven to be a sufficient contract for adapters written by other people.
- A server-side streaming path for MySQL. `mysql2` can stream, but only through its
  callback API, and wiring that up means a second cursor lifetime to get right. Today
  `stream` is correct there but does not reduce peak memory, and that is documented.

## Never

- **Relations, eager loading, and a query builder DSL.** These are the ORM features this
  package exists to avoid. Use an ORM if you want them; that is a legitimate choice, just a
  different one.
- **Full-text search.** Not a matter of taste, but of what the conformance suite can
  assert. Postgres stems and applies stop words by default, SQLite's FTS5 tokenizer does
  neither, and MySQL's minimum token length silently drops one- and two-character terms and
  is a server startup variable an adapter cannot set per connection. Three engines would
  return three different sets of rows for one query, which is precisely what every other
  operator is normalized to prevent. `like` and `ilike` are the portable substitute; reach
  for the driver directly when you need real FTS, in one clearly marked place.

- **A migration engine.** Pair repolayer with `node-pg-migrate` or a SQL-file runner. See
  [`ensureTable()`](docs/api.md#ensuretable). [`verifyTable()`](docs/api.md#verifytable) is
  deliberately not one either: it reads the catalog and reports, and executes no DDL.
- **Raw SQL passthrough on the `Repo` interface.** Dialect-specific SQL is fine and
  sometimes necessary, but it belongs in one clearly marked place using the driver
  directly, not smuggled through an interface whose entire promise is that every engine
  behaves the same.
- **Quoted identifiers.** They would allow reserved words as column names, but Postgres
  folds unquoted identifiers to lowercase, so quoting them would make `createdAt` refer to
  a different column than every existing table has. A documented limitation beats a silent
  break.
