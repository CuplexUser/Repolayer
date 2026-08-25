# Engines

Four backends satisfy one interface. This is what that costs, what it normalizes, and where
the engines genuinely differ, documented rather than papered over.

| driver | engine | needs | notes |
|---|---|---|---|
| `sqlite` | SQLite, through `node:sqlite` | nothing | single writer, no server |
| `postgres` | PostgreSQL | `pg` | server-side cursors, `JSONB` |
| `mysql` | MySQL **and** MariaDB | `mysql2` | flavor detected at connect |
| (none) | `MemoryRepo`, for tests | nothing | see [testing.md](testing.md) |

Requires Node 22.5 or newer. `node:sqlite` is stable on Node 24+, unflagged on 23.4+, and
needs `--experimental-sqlite` on 22.5 through 23.3. The other engines have no such
constraint.

- [What is normalized](#what-is-normalized)
- [What is not, and cannot be](#what-is-not-and-cannot-be)
- [MySQL and MariaDB specifics](#mysql-and-mariadb-specifics)

## What is normalized

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
- **Constraint errors.** `SQLITE_CONSTRAINT_UNIQUE`, SQLSTATE `23505`, and MySQL error `1062`
  all become `UniqueConstraintError`, naming the same schema field.
- **`RETURNING`.** SQLite and Postgres have it, MySQL does not. On MySQL a `create` or
  `update` is a write plus a keyed read on one connection inside a transaction, so the return
  value is the same; it just costs a second statement.

## What is not, and cannot be

- **SQLite allows one writer at a time.** Concurrent write transactions serialize, and a slow
  transaction blocks other writers for its whole duration. WAL mode and a 5 second
  `busy_timeout` are on by default, but the model itself does not change. This is usually the
  reason to move to Postgres, and it is a real difference rather than a bug.
- **Transaction isolation.** SQLite is effectively serializable; Postgres defaults to read
  committed. Code that depends on the distinction needs to know which engine it is on.
- **Everything outside the query shape.** Full-text search, window functions, arrays, and
  extensions are all deliberately outside this interface. Use the driver directly for those,
  in one clearly marked place. Full-text search in particular is not coming later:
  [the roadmap](../ROADMAP.md#never) has the reason, which is that the three engines
  genuinely disagree about which rows one query matches.
- **Ties in an `orderBy` are not normalized.** Rows that tie on every sort key come back in
  whatever order the engine read them, which is not the same order on every engine or even on
  every run. `findPage` appends the primary key so that paging cannot skip or repeat a row,
  but `findMany`, `findOne`, and `stream` pass the sort through as written. If the order of
  tied rows matters, name a unique last sort key.
- **Comparing a whole `json` value is textual, except on Postgres.** A json field is stored as
  the exact output of `JSON.stringify`, and `eq` and `ne` compare that text, so a filter has
  to be written the same shape it was stored in. Postgres compares `JSONB` structurally and so
  also matches the same document written with its keys in another order.

## MySQL and MariaDB specifics

One adapter serves both. It asks the server what it is at connect time and adjusts the two
things that genuinely differ between them, so `driver: 'mysql'` is correct for either.

- **Text columns must be utf8mb4.** `ensureTable` creates them as
  `utf8mb4 COLLATE utf8mb4_bin`, because the server default is a case-insensitive collation
  under which `=`, `in`, `unique`, and `ORDER BY` on text would all behave differently than on
  SQLite and Postgres. If your tables come from a migration tool, create string columns the
  same way: forcing a collation onto a latin1 column is an error rather than a comparison.
- **Reserved words.** Identifiers are never quoted, on any engine, so a column named `order`
  or `rank` will not work. Quoting them would change how Postgres folds case on existing
  tables, which is a worse trade than the limitation.
- **Driver options are set for you.** `FOUND_ROWS`, `jsonStrings`, `dateStrings`, and the
  big-number options are not preferences: each one exists to make a specific conformance case
  pass, and they are applied whether the pool is repolayer's or yours.
- **Dates are stored as UTC `DATETIME(6)`** and parsed back as UTC explicitly, so a timestamp
  does not shift when the server's timezone does.
- **`json` columns are `LONGTEXT`, not the native `JSON` type.** A native JSON column holds a
  normalized document, and MySQL does not match one against the text repolayer binds, so `eq`
  and `ne` on a json field would answer differently there than on MariaDB, SQLite, and
  `MemoryRepo`. MariaDB's `JSON` is a `LONGTEXT` alias already. If your tables come from a
  migration tool and use the native type, filtering a whole json value will not match; read
  the field and compare it in application code instead.
- **No server-side cursor for a plain SELECT.** `stream` fetches the result and hands it out
  in batches, so the API is identical but peak memory is not reduced. See
  [streaming.md](streaming.md).
