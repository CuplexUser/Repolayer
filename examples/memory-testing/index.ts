/**
 * Unit-testing application logic against `MemoryRepo`, with no database at all.
 *
 * The service below is written against `Repo<Order>` and knows nothing about storage. In
 * production it gets a Postgres repo; here it gets an in-memory one, and the tests run in
 * milliseconds with no container, no file, and no cleanup.
 *
 * The reason that is safe rather than merely convenient: `MemoryRepo` passes the same
 * conformance suite as the SQLite, Postgres, and MySQL adapters. A fake that quietly
 * behaves differently from the real thing is worse than no fake at all, because the tests
 * it passes stop meaning anything.
 *
 *   npm run example:memory-testing
 */
import assert from 'node:assert/strict';

import { defineSchema, NotFoundError, type Infer, type Repo } from '../../dist/index.js';
import { MemoryRepo, MemoryStore } from '../../dist/memory/index.js';

const orderSchema = defineSchema({
  id: { type: 'string', primaryKey: true },
  reference: { type: 'string', unique: true },
  customer: { type: 'string' },
  total: { type: 'number' },
  status: { type: 'string' },
  placedAt: { type: 'date', column: 'placed_at' },
});

type Order = Infer<typeof orderSchema>;

// ---------------------------------------------------------------- the code under test

/**
 * Ordinary application logic. Note what is absent: any mention of a driver, a connection,
 * or SQL. This is the code you would write once and never revisit after changing engines,
 * and it is also the code these tests exercise directly.
 */
class OrderService {
  // Written out rather than as a parameter property, because Node's type stripping does
  // not support those and these examples run under `node --experimental-strip-types`.
  private readonly orders: Repo<Order>;

  constructor(orders: Repo<Order>) {
    this.orders = orders;
  }

  async place(reference: string, customer: string, total: number): Promise<Order> {
    if (total <= 0) throw new Error('An order total must be positive');
    return this.orders.create({
      reference,
      customer,
      total,
      status: 'pending',
      placedAt: new Date(),
    });
  }

  async ship(id: string): Promise<Order> {
    const order = await this.orders.findById(id);
    if (order === null) throw new NotFoundError('orders', id);
    if (order.status !== 'paid') throw new Error(`Cannot ship an order that is ${order.status}`);
    return this.orders.update(id, { status: 'shipped' });
  }

  /** Marks every pending order for a customer as paid, and says how many there were. */
  async markPaid(customer: string): Promise<number> {
    return this.orders.updateMany(
      {
        where: [
          { field: 'customer', op: 'eq', value: customer },
          { field: 'status', op: 'eq', value: 'pending' },
        ],
      },
      { status: 'paid' },
    );
  }

  /** The high-value orders, newest first, one page at a time. */
  async highValuePage(
    minimum: number,
    after: string | null,
  ): Promise<{ refs: string[]; next: string | null }> {
    const page = await this.orders.findPage(
      {
        where: [{ field: 'total', op: 'gte', value: minimum }],
        orderBy: [{ field: 'placedAt', direction: 'desc' }],
      },
      { limit: 2, after },
    );
    return { refs: page.items.map((o) => o.reference), next: page.hasMore ? page.cursor : null };
  }

  /** Totals every order matching a status, without holding them all in memory. */
  async revenue(status: string): Promise<number> {
    let total = 0;
    for await (const order of this.orders.stream({ where: { status } })) total += order.total;
    return Math.round(total * 100) / 100;
  }
}

// ---------------------------------------------------------------- a tiny test harness

let passed = 0;

async function test(name: string, fn: (service: OrderService) => Promise<void>): Promise<void> {
  // A fresh store per test, which is the memory equivalent of a fresh database and costs
  // nothing. No container to start, no table to drop, no ordering between tests.
  const repo = new MemoryRepo<Order>({
    table: 'orders',
    schema: orderSchema,
    store: new MemoryStore(),
    timestamps: {},
  });

  await fn(new OrderService(repo));
  passed += 1;
  console.log(`  ok  ${name}`);
}

console.log('OrderService, tested with no database:');

await test('places an order as pending', async (service) => {
  const order = await service.place('ref-1', 'ada', 42.5);
  assert.equal(order.status, 'pending');
  assert.equal(order.total, 42.5);
  assert.match(order.id, /^[0-9a-f]{8}-/);
});

await test('refuses a non-positive total before touching storage', async (service) => {
  await assert.rejects(() => service.place('ref-2', 'ada', 0), /must be positive/);
});

await test('refuses a duplicate reference, because the schema says unique', async (service) => {
  await service.place('ref-3', 'ada', 10);
  // The unique constraint is enforced here exactly as a real engine would enforce it, so
  // this failure mode is testable without a database.
  await assert.rejects(() => service.place('ref-3', 'grace', 20), /Unique constraint/);
});

await test('will not ship an order that has not been paid', async (service) => {
  const order = await service.place('ref-4', 'ada', 10);
  await assert.rejects(() => service.ship(order.id), /Cannot ship an order that is pending/);
});

await test('ships a paid order', async (service) => {
  const order = await service.place('ref-5', 'ada', 10);
  await service.markPaid('ada');
  assert.equal((await service.ship(order.id)).status, 'shipped');
});

await test('raises NotFoundError for an order that does not exist', async (service) => {
  await assert.rejects(() => service.ship('nope'), NotFoundError);
});

await test('marks only that customer pending orders as paid', async (service) => {
  await service.place('ref-6', 'ada', 10);
  await service.place('ref-7', 'ada', 20);
  await service.place('ref-8', 'grace', 30);
  assert.equal(await service.markPaid('ada'), 2);
  assert.equal(await service.markPaid('ada'), 0);
});

await test('pages high-value orders newest first', async (service) => {
  for (const [i, total] of [5, 100, 250, 400, 30].entries()) {
    await service.place(`ref-page-${i}`, 'ada', total);
    // Distinct timestamps, so "newest first" has something to sort on.
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  const seen: string[] = [];
  let next: string | null = null;
  do {
    const page: { refs: string[]; next: string | null } = await service.highValuePage(50, next);
    seen.push(...page.refs);
    next = page.next;
  } while (next !== null);

  assert.deepEqual(seen, ['ref-page-3', 'ref-page-2', 'ref-page-1']);
});

await test('sums revenue through a stream', async (service) => {
  await service.place('ref-9', 'ada', 19.99);
  await service.place('ref-10', 'ada', 5.01);
  await service.markPaid('ada');
  assert.equal(await service.revenue('paid'), 25);
});

await test('rolls back a failed transaction', async (service) => {
  const order = await service.place('ref-11', 'ada', 10);
  const repo = (service as unknown as { orders: Repo<Order> }).orders;

  await repo
    .withTransaction(async (tx) => {
      await tx.update(order.id, { status: 'cancelled' });
      throw new Error('changed my mind');
    })
    .catch(() => undefined);

  assert.equal((await repo.findById(order.id))?.status, 'pending');
});

console.log(`\n${passed} tests passed, no database involved.`);
