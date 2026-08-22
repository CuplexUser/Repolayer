/**
 * The storage engines with an adapter.
 *
 * MySQL and MariaDB share one dialect. They differ in a handful of places (whether
 * RETURNING exists, which collations are spelled how, how a duplicate-key message reads),
 * and the adapter detects which one it is talking to at connect time. Giving them separate
 * dialects would double every branch in the compiler for differences that are almost all
 * cosmetic.
 *
 * `memory` is not SQL at all: `MemoryRepo` evaluates queries in JavaScript. It is a
 * `Dialect` anyway because serialization is keyed off this value, and because the same
 * query shape compiling to SQL *and* to an in-process evaluator is the evidence that the
 * shape is not secretly SQL.
 */
export type Dialect = 'sqlite' | 'postgres' | 'mysql' | 'memory';

/** Which of the two MySQL-family servers is on the other end of the connection. */
export type MysqlFlavor = 'mysql' | 'mariadb';
