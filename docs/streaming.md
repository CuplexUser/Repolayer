# Streaming and paging

Two ways to read more rows than one array should hold. `stream` keeps a cursor open and walks
the whole result once; `findPage` holds nothing and hands out a token so the walk can be
resumed later, or by a different process.

- [Streaming](#streaming)
- [Paging](#paging)
- [Which one to use](#which-one-to-use)

## Streaming

```ts
for await (const row of repo.stream({ where: { status: 'queued' } }, { batchSize: 500 })) {
  await handle(row);
}
```

Rows arrive in batches instead of all at once, so a table larger than memory can be exported,
migrated, or re-indexed. `batchSize` defaults to 100 and only trades memory against round
trips; it never changes which rows are returned or in what order.

It is a real server-side cursor on Postgres, a `DECLARE` plus repeated `FETCH FORWARD`, and a
stepped statement on SQLite, `StatementSync.iterate()`. Both hold a resource for as long as
the loop runs, so the contract around leaving early is the important part:

- Leaving the loop with `break`, `return`, or a throw closes the cursor and ends the
  transaction it opened. Nothing leaks, and the suite asserts the pool returns to its
  baseline size after an early break.
- An iterable you never iterate never opens anything.
- Pass an `AbortSignal` to cancel from outside the loop. The signal's reason is what gets
  thrown, so a caller's own error object comes back out unchanged.
- To write inside the loop as part of the same transaction, stream from a transaction-bound
  repo: `repo.withTransaction(async (tx) => { for await (const row of tx.stream()) ... })`.

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(new Error('took too long')), 30_000);

for await (const row of repo.stream({}, { signal: controller.signal })) {
  await handle(row);
}
```

Two limits worth knowing. On SQLite a long-lived cursor holds a read lock, and on a
single-writer engine that blocks writers for its whole duration; mutating the table you are
streaming is unspecified, so write to a different one. On MySQL there is no server-side
cursor for a plain SELECT, so `stream` fetches the result and hands it out in batches: the
API is identical, but peak memory is not reduced there.

`npm run example:stream-export` runs cursors, an early exit, and a cancellation end to end.

## Paging

```ts
const page = await repo.findPage(
  { orderBy: [{ field: 'createdAt', direction: 'desc' }] },
  { limit: 50, after: previousPage.cursor },
);
// { items: T[], cursor: string | null, hasMore: boolean }
```

`findPage` is keyset paging with an opaque cursor token. The token encodes the sort-key values
of the last row, and the next page compiles to a keyset predicate rather than an `OFFSET`.

That matters for two reasons: page 10,000 costs the same as page 1, and rows inserted or
deleted during the walk cannot shift a page underneath you. `npm run example:paging-api` runs
both approaches side by side against a table that is being written to, and offset paging
visibly repeats rows that keyset paging does not.

Three details the implementation insists on:

- **The sort is made total.** The primary key is appended as a final tiebreaker unless you
  already sorted by it. Without that, rows that tie on every sort key have no defined order,
  and a page boundary landing inside a tie skips one row and repeats another. Note what that
  means when ids are uuids: tied rows come back in an arbitrary order, and two databases
  holding the same rows will disagree about it. Name a unique second sort key yourself if a
  tie needs a defined order.
- **A token is only valid for the sort that produced it.** It carries a fingerprint of the
  `orderBy`, and using it under a different one throws rather than paging wrongly.
- **Tokens carry a version.** One minted by an older deployment fails loudly instead of being
  misread.

`findPage` rejects an `offset`, because mixing the two is always a mistake.

## Which one to use

| | `stream` | `findPage` |
|---|---|---|
| holds between calls | an open cursor, and on SQLite a read lock | nothing |
| resumable later, or elsewhere | no | yes, the cursor token is all it needs |
| correct under concurrent writes | reads one snapshot | yes, and page depth costs nothing |
| best for | one pass over everything: export, migration, re-index | an API endpoint, a UI that pages |
