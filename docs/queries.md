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
- [`orderBy`](#orderby)
- [`limit` and `offset`](#limit-and-offset)
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

## What is rejected

A query that cannot be compiled throws `QueryError`, always before any SQL reaches the
database:

- a `field` that is not in the schema
- an `op` that is not one of the eleven operators
- `in` or `nin` with a value that is not an array
- a value that cannot be serialized to the field's declared type
- a `limit` or `offset` that is negative or not an integer
- a filter tree deeper than 16 levels

Values never reach the SQL text. Every one becomes a bound parameter, including the pattern
of a `like`, and `MemoryRepo` escapes those patterns before turning them into a regular
expression for the same reason.
