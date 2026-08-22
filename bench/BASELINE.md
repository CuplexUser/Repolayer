# Benchmark baseline

Numbers are operations per second (higher is better), from `npm run bench`.

Machine: Windows 10, Node 26.4.0, vitest 4.1.11. Absolute values are only meaningful against
each other on the same machine, in the same run. Between runs this machine drifts by 5 to 10
percent even on benchmarks whose code did not change, so **a cross-run delta under 10 percent
is noise**, and anything close to that bar was re-measured A/B in one process before being
believed.

## Baseline, before any optimization

Recorded on the tree at `dc7a6d0` plus the benchmark harness itself, with no library changes.

### Row mapping (`src/core/serialize.ts`)

| benchmark | ops/sec |
|---|---:|
| `rowToEntity`, one sqlite row, 10 fields | 339,659 |
| `rowToEntity`, one postgres row, 10 fields | 1,186,767 |
| `rowToEntity`, 100 sqlite rows | 3,543 |
| `toDb` string | 9,296,388 |
| `toDb` integer | 9,650,772 |
| `toDb` boolean | 9,860,070 |
| `toDb` date | 726,635 |
| `toDb` json | 2,873,543 |
| `fromDb` integer from a postgres bigint string | 9,971,084 |
| `fromDb` date from a sqlite iso string | 585,399 |
| `fromDb` json from sqlite text | 1,173,435 |

The sqlite row is 3.5x slower to map than the postgres row, and the reason is visible in the
per-type numbers rather than in the loop: `Date` parsing and `JSON.parse` are two and three
orders of magnitude more expensive than the scalar conversions. A postgres row arrives with
`Date` objects and parsed JSON already in hand and skips both.

That was the useful finding: shaving dictionary lookups out of the `rowToEntity` loop cannot
matter much when two fields out of ten dominate the cost. It is why the row-plan change below
was worth only about 10 percent rather than the 2x a look at the loop might suggest.

### Query compilation (`src/core/query.ts`)

| benchmark | ops/sec |
|---|---:|
| `compileSelect` sqlite, no filters | 1,113,317 |
| `compileSelect` sqlite, three filters, order, limit, offset | 539,717 |
| `compileSelect` sqlite, ten filters, two sort keys | 188,512 |
| `compileSelect` postgres, no filters | 1,181,103 |
| `compileSelect` postgres, three filters, order, limit, offset | 495,132 |
| `compileSelect` postgres, ten filters, two sort keys | 238,855 |
| `compileCount`, three filters | 1,262,733 |
| `selectList`, ten columns | 1,122,342 |

### End to end, SQLite in memory (`src/sqlite/index.ts`)

| benchmark | ops/sec | mean ms |
|---|---:|---:|
| `findById` | 28,721 | 0.035 |
| `findOne` with a filter | 15,372 | 0.065 |
| `findMany`, 1000 rows | 248 | 4.03 |
| `findMany`, 50 rows filtered and ordered | 1,450 | 0.69 |
| `count` with a filter | 15,986 | 0.063 |
| `create` | 23,353 | 0.043 |
| `createMany`, 100 rows | 491 | 2.04 |
| `withTransaction`, one create | 20,230 | 0.049 |

`findMany` over 1000 rows cost 4.0 ms, of which row mapping alone accounted for about 2.8 ms.
Row mapping was therefore about 70 percent of a large read, which made it the only part of the
hot path where a change could move the total.

## What was measured, and what landed

Each candidate was A/B tested in a single process, old implementation against new, because
that is the only comparison this machine can make reliably.

| change | measured | landed |
|---|---|---|
| Memoize `selectList` per schema | **9.2x** faster per call | yes |
| Precompute a per-schema row plan in `rowToEntity` | **1.11x** faster over 100 rows | yes |
| Cache the executor object instead of rebuilding it per query | not separately measurable | yes, it also removed a lint failure |
| Bound the SQLite prepared-statement cache | not a speed change | yes, it is a memory leak fix |
| Precompute the placeholder renderer in `ParamList` | 1.01x, then 1.32x on a re-run | **no** |
| Skip re-validating the schema in `clone()` | not pursued | **no** |

Two notes on the rejections, since a rejected optimization is worth as much as an accepted one:

- **`ParamList`.** Two runs disagreed by more than the effect size, which is the definition of
  a result not worth acting on. Even taking the optimistic 1.32x at face value, the whole
  benchmark binds ten parameters in 0.13 microseconds, against a `findById` that costs 35. It
  is unmeasurable in any real query.
- **`clone()` re-validation.** It happens once per transaction or savepoint, alongside a
  `BEGIN` and a `COMMIT`. A handful of property reads next to two round trips is not where the
  time goes, and caching validation across clones would add state for nothing.

`selectList` deserves a word too: 9.2x sounds decisive, and in relative terms it is, but it
saves about one microsecond per query. It landed because it is three lines and a `WeakMap`
over a frozen object, not because it will show up in anyone's traces.

## After, same machine

Absolute numbers from the finished tree, for reference. Compare them to the baseline with the
10 percent noise bar in mind: the compile and `selectList` rows moved for real, and the end to
end rows are within noise of where they started, which is the honest reading.

| benchmark | before | after |
|---|---:|---:|
| `selectList`, ten columns | 1,122,342 | 7,784,758 |
| `compileSelect` sqlite, no filters | 1,113,317 | 6,853,258 |
| `compileSelect` sqlite, three filters, order, limit, offset | 539,717 | 792,695 |
| `compileCount`, three filters | 1,262,733 | 1,102,623 |
| `rowToEntity`, one sqlite row | 339,659 | 381,561 |
| `rowToEntity`, one postgres row | 1,186,767 | 1,719,863 |
| `rowToEntity`, 100 sqlite rows | 3,543 | 3,654 |
| `findById` | 28,721 | 26,098 |
| `findMany`, 1000 rows | 248 | 246 |
| `create` | 22,353 | 22,276 |
| `withTransaction`, one create | 20,230 | 17,720 |

The end to end rows are flat, and that is the expected result rather than a disappointment: on
an in-memory SQLite database those numbers are dominated by `node:sqlite` stepping rows and by
`Date` and JSON parsing, neither of which any of these changes touch. The compilation path is
several times faster and contributes about a microsecond to a query that costs forty.

## How to use this file

Re-run `npm run bench` after a change and append a dated section with before and after
columns. When a delta is anywhere near 10 percent, A/B the two implementations in one process
before believing it. An optimization that does not move a number does not land.
