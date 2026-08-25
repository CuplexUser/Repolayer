# Testing

Two things live here: a fake you can point your own unit tests at, and the conformance suite
that is the reason the fake, and every adapter, can be trusted.

- [Testing without a database](#testing-without-a-database)
- [Sharing a store, and transactions](#sharing-a-store-and-transactions)
- [The conformance suite](#the-conformance-suite)

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

It is also the strongest evidence available that `QueryOptions` is not a SQL builder in
disguise. Nothing in it compiles a string: filters are evaluated, ordering is a comparator,
and paging reuses the very same keyset predicate the SQL adapters compile, just interpreted
instead.

What it does not model, and does not pretend to: isolation levels, concurrent writers, and
anything about how a real engine schedules work. Use it to test your logic, not your
database. `npm run example:memory-testing` shows a service tested end to end this way.

## Sharing a store, and transactions

Each `MemoryRepo` owns a store unless you hand it one. Passing the same `MemoryStore` to two
repos is what lets them see each other's writes and take part in one transaction, the way two
repos built from one pool do:

```ts
import { MemoryRepo, MemoryStore } from 'repolayer/memory';

const store = new MemoryStore();
const users = new MemoryRepo<User>({ table: 'users', schema: userSchema, store });
const orders = new MemoryRepo<Order>({ table: 'orders', schema: orderSchema, store });

await users.withTransaction(async (tx, ctx) => {
  const user = await tx.create({ email: 'a@example.com' });
  await orders.with(ctx).create({ userId: user.id });
});
```

`ids` and `timestamps` work as they do in [`createRepo`](api.md#createrepoconfig), so a test
double generates the same kind of ids as the engine it stands in for.

## The conformance suite

Every adapter runs one shared test suite, exported as `repolayer/testing`. That is what turns
"the backends behave identically" from a hope into something checked on every commit, and it
is available to third-party adapters too:

```ts
import { runConformanceSuite } from 'repolayer/testing';

runConformanceSuite({
  name: 'my-engine',
  async createRepo(options) {
    /* a repo over a fresh, isolated table, built per test */
  },
  async cleanup() {
    /* runs once, after the whole suite */
  },
});
```

| field | meaning |
|---|---|
| `name` | shown in the test output, such as `'sqlite'` |
| `createRepo(options)` | builds a repo over a fresh table. Called once per test, so nothing depends on test order |
| `cleanup()` | optional, runs once after the suite |
| `unsupported` | capabilities this engine cannot provide, each with a stated reason |
| `busyConnections()` | how many connections are checked out right now, when the engine pools |

`createRepo` receives `{ schema, table, ids, timestamps }` and must honor all four. The suite
generates a unique table name per test, tagged with a per-process random suffix, so two CI
jobs pointed at the same server cannot collide.

`unsupported` takes `'transactions'`, `'autoincrement'`, or `'introspection'`, each mapped to
a reason string. Declaring one is a deliberate, visible statement rather than a quiet skip: an
adapter that simply fails those tests is broken, while one that declares them is documented.

`'introspection'` is for an engine with no catalog to read, where `verifyTable()` cannot find
drift because there is none to find. `MemoryRepo` declares it. Note that declaring it does not
excuse an adapter from `verifyTable()` entirely: the case asserting a freshly created table
reports clean still runs, because every adapter has to answer that question.

`busyConnections` is worth wiring up if the engine has a pool. When it is present, the cursor
cases assert the count returns to its baseline after a consumer leaves a stream early. A
leaked connection is invisible until the pool is exhausted, at which point the process
deadlocks with no clue as to why.

The suite is written for [Vitest](https://vitest.dev), which is an optional peer dependency
for exactly this reason: it is only needed if you import `repolayer/testing`.

For how the first-party adapters are run against real engines, see
[contributing.md](contributing.md#testing-against-real-engines).
