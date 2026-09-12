# Queries

Every read and every bulk write takes the same shape, `QueryOptions<T>`, and every adapter
compiles it the same way.

```ts
interface QueryOptions<T> {
  where?: Partial<T> | Filter<T>[];
  orderBy?: { field: keyof T & string; direction: 'asc' | 'desc' }[];
  limit?: number;
  offset?: number;
}
```

It is deliberately not a query builder. The shape is plain JSON, so a filter can cross an
HTTP boundary, sit in a queue, or live in a config file with no serializer, and a restricted
shape is what lets four very different engines behave the same way.

- [`where`](#where)
- [Filter trees](#filter-trees)
- [Operators](#operators)
- [Operators by type](#operators-by-type)
- [`orderBy`](#orderby)
- [`limit` and `offset`](#limit-and-offset)
- [Aggregation and `groupBy`](#aggregation-and-groupby)
- [Distinct values](#distinct-values)
- [What is rejected](#what-is-rejected)

## `where`

The object form is read as an implicit AND of equality checks, which covers most queries:

```ts
await repo.findMany({ where: { solved: false, difficulty: 5 } });
```

The array form is an implicit AND of filters, which is what you need as soon as an operator
other than equality is involved:

```ts
await repo.count({
  where: [
    { field: 'difficulty', op: 'gte', value: 5 },
    { field: 'title', op: 'ilike', value: 'sud%' },
  ],
});
```

Omitting `where` matches every row.

## Filter trees

For anything that is not a flat AND, group the filters. Groups nest, and the whole thing
stays plain JSON.

```ts
await repo.findMany({
  where: [
    { field: 'solved', op: 'eq', value: false },        // AND
    {
      or: [
        { field: 'difficulty', op: 'gte', value: 8 },
        { and: [
          { field: 'tags', op: 'isNull', value: false },
          { field: 'title', op: 'ilike', value: 'sud%' },
        ] },
      ],
    },
  ],
});
```

Groups are always parenthesized in the generated SQL, so precedence cannot slip. An empty
`or` matches nothing and an empty `and` matches everything, the same convention an empty `in`
and `nin` already follow.

Nesting is capped at 16 levels. A filter is serializable by design, which means it can arrive
from a request, and an unbounded tree would compile to unbounded SQL.

## Operators

| operator | meaning | notes |
|---|---|---|
| `eq` | equals | `value: null` means IS NULL |
| `ne` | not equals | keeps NULL rows, which raw SQL would drop |
| `gt` `gte` `lt` `lte` | comparison | |
| `in` | one of | empty array matches nothing |
| `nin` | none of | empty array matches everything, keeps NULL rows |
| `like` | pattern, case **sensitive** | `%` and `_` wildcards |
| `ilike` | pattern, case **insensitive** | |
| `isNull` | is null | `value: false` inverts it |

`like` and `ilike` mean the same thing on every engine, which takes work: SQLite's LIKE is
case insensitive for ASCII by default, Postgres's is not, and MySQL's depends on the column
collation. See [engines.md](engines.md) for how that is normalized, and for the one place
where comparing a whole `json` value differs.

## Operators by type

Not every operator means the same thing on every type, and where the engines would disagree
the query is refused with a `QueryError` before it reaches any of them.

| type | filter operators | `orderBy`, `findPage` | `groupBy`, `distinct` | `min` / `max` | `sum` / `avg` |
|---|---|---|---|---|---|
| `string` | all eleven | yes | yes | yes | no |
| `number`, `integer` | all but `like` and `ilike` | yes | yes | yes | yes |
| `boolean` | all but `like` and `ilike` | yes | yes | no | no |
| `date` | all but `like` and `ilike` | yes | yes | yes | no |
| `json` | `eq`, `ne`, `in`, `nin`, `isNull` | no | no | no | no |
| `binary` | `eq`, `ne`, `in`, `nin`, `isNull` | no | no | no | no |

The reasons, in order of how often they come up:

- **A pattern only matches text.** SQLite stores a date as ISO text and would match
  `createdAt like '2024-%'`, while Postgres refuses to apply LIKE to a timestamp at all. Filter
  a date with `gte` and `lt` instead, which every engine answers the same way.
- **A `json` value has no order the engines share.** Postgres compares `jsonb` documents
  structurally and SQLite and MySQL compare the stored text, so they would sort and group the
  same rows differently. Sort by a column that holds the part you care about.
- **Postgres has no `min` or `max` of a boolean.** Order by the field, or count per value with
  `groupBy`.
- **`binary` supports equality only, for now.** Two values are equal when every byte matches,
  so `[1, 2]` and `[1, 2, 0]` are different values on every engine.

## `orderBy`

```ts
orderBy: [
  { field: 'difficulty', direction: 'desc' },
  { field: 'createdAt', direction: 'asc' },
];
```

NULL position is stated explicitly in every generated `ORDER BY`, so nullable columns sort
the same way on every engine rather than following each one's default.

Ties are not normalized. Rows that tie on every sort key come back in whatever order the
engine read them, which is not the same order on every engine or even on every run. If the
order of tied rows matters, name a unique last sort key such as the primary key.
[`findPage`](streaming.md#paging) is the exception: it appends the primary key itself,
because a page boundary landing inside a tie would skip and repeat rows.

## `limit` and `offset`

```ts
await repo.findMany({
  orderBy: [{ field: 'createdAt', direction: 'desc' }],
  limit: 20,
  offset: 40,
});
```

Both have to be non-negative integers. `offset` walking deep into a table gets slower the
deeper it goes, and rows written during the walk shift pages underneath it, which is what
[`findPage`](streaming.md#paging) exists to fix. `count` ignores both, and `findPage` rejects
`offset` outright.

## Aggregation and `groupBy`

`repo.aggregate()` is the one read that does not return entities. It answers a question about
a set of rows rather than handing the rows back, so each record holds the `groupBy` fields at
their entity types plus one property per aggregate alias.

```ts
const byDifficulty = await repo.aggregate({
  where: [{ field: 'solved', op: 'eq', value: true }],   // filters rows
  groupBy: ['difficulty'],
  aggregates: {
    puzzles: { fn: 'count' },
    firstSolved: { fn: 'min', field: 'createdAt' },
  },
  having: [{ alias: 'puzzles', op: 'gte', value: 2 }],   // filters groups
  orderBy: [{ field: 'puzzles', direction: 'desc' }],
  limit: 10,
});
// [{ difficulty: 3, puzzles: 7, firstSolved: Date }, ...]
```

Omitting `groupBy` reduces the whole filtered set to a single record, which is what a totals
row is:

```ts
const [totals] = await repo.aggregate({
  aggregates: {
    puzzles: { fn: 'count' },
    hardest: { fn: 'max', field: 'difficulty' },
    mean: { fn: 'avg', field: 'difficulty' },
  },
});
```

| aggregate | needs a field | reads back as | notes |
|---|---|---|---|
| `count` | no | `number`, never null | with no field it counts rows, with one it counts non-null values |
| `sum` | number or integer | the field's type, or null | null over no values, not zero |
| `avg` | number or integer | `number`, or null | always computed in double precision |
| `min` `max` | string, number, integer, or date | the field's type, or null | a min over a date is a `Date` |

`distinct: true` on a `count`, `sum`, or `avg` reduces each value once
(`{ fn: 'count', field: 'title', distinct: true }`).

Three things are worth stating outright, because they are where engines usually disagree:

- **An aggregate over no values is null, not zero.** A `count` is the exception: it is a
  number even when there is nothing to count. An ungrouped aggregate over an empty table still
  returns exactly one record, with a zero count and null everywhere else, and a grouped one
  returns no records at all.
- **`avg` is computed in double precision on every engine.** Left alone, Postgres would answer
  with sixteen decimal places, MySQL with four, and SQLite with a double, so the same rows
  would produce three different numbers.
- **`where` filters rows before grouping, `having` filters groups after.** `having` names an
  aggregate alias, never a column, and it takes the comparison operators plus `isNull`. Like
  `ne` on a column, `having` with `ne` keeps a group whose aggregate is null.

An alias becomes an unquoted SQL identifier, so it has to be a plain identifier, and two names
in one result cannot differ only in case, because Postgres folds unquoted identifiers to lower
case. Avoid engine keywords such as `rows` or `groups` for the same reason column names avoid
them.

## Distinct values

```ts
const statuses = await repo.distinct(['status'], {
  where: [{ field: 'archived', op: 'eq', value: false }],
  orderBy: [{ field: 'status', direction: 'asc' }],
});
// [{ status: 'draft' }, { status: 'published' }]
// statuses.map((row) => row.status) for the bare list
```

Deduplication is on the selected fields only, so naming several fields returns each distinct
combination rather than each field's values independently. A null is one distinct value, and
sorts by the same rule as everywhere else.

`orderBy` may only name fields the read selects. Postgres refuses to order a distinct read by
a column it does not select, and SQLite accepts it and picks an arbitrary row per group, so
the query is refused everywhere rather than meaning two things.

## What is rejected

A query that cannot be compiled throws `QueryError`, always before any SQL reaches the
database:

- a `field` that is not in the schema
- an `op` that is not one of the eleven operators, or one the field's type does not support
  (see [Operators by type](#operators-by-type)), such as `like` on a number or a date
- an `orderBy` or `findPage` sort on a `json` or `binary` field
- `in` or `nin` with a value that is not an array
- a value that cannot be serialized to the field's declared type
- a `limit` or `offset` that is negative or not an integer
- a filter tree deeper than 16 levels
- an aggregate no engine could answer identically: summing or averaging anything but a number
  or an integer, a `min` or `max` over a `boolean` (Postgres has none), a `json` value, or a
  `binary` value, and grouping, counting distinct, or `distinct` on a `json` or `binary` field
- an aggregate alias that is not a plain identifier, or two names in one grouped result that
  differ only in case
- a `having` that names a column rather than an aggregate alias, and an aggregate `orderBy`
  that names neither a group field nor an alias
- a `distinct` read ordered by a field it does not select

Values never reach the SQL text. Every one becomes a bound parameter, including the pattern
of a `like`, and `MemoryRepo` escapes those patterns before turning them into a regular
expression for the same reason.
