# Contributing

- [Development](#development)
- [Examples](#examples)
- [Testing against real engines](#testing-against-real-engines)
- [Releasing](#releasing)

## Development

```bash
npm run build       # ESM + CJS + type declarations
npm run typecheck   # tsc --noEmit
npm run lint        # eslint + prettier --check
npm test            # unit tests, plus SQLite and MemoryRepo conformance. No setup needed.
npm run bench       # benchmarks, compared against bench/BASELINE.md
```

`npm test` runs everything that needs no external service, which is the unit tests plus two
full conformance runs: SQLite and `MemoryRepo`.

Markdown is excluded from Prettier on purpose. The code samples use deliberate column
alignment that Prettier would flatten, and the prose is wrapped by hand.

Anything that changes behavior belongs in the shared conformance suite rather than in one
adapter's own tests, since the whole premise is that all four backends answer the same way.
A new adapter is not a fork of an existing one: implement `Repo<T>`, run
[the suite](testing.md#the-conformance-suite), and declare anything the engine genuinely
cannot do.

## Examples

Each one runs standalone, against SQLite unless it says otherwise.

```bash
npm run example:swap            # the same logic on every engine, output diffed
npm run example:stream-export   # cursors, early exit, and cancellation
npm run example:paging-api      # keyset paging against offset paging, under writes
npm run example:memory-testing  # a service unit-tested with no database
```

## Testing against real engines

```bash
npm run test:pg       # starts Postgres in docker compose and runs the full suite
npm run test:mysql    # the same, against MySQL
npm run test:mariadb  # the same, against MariaDB
npm run test:all      # every engine at once
npm run db:down       # stops them and removes the volumes
```

The Postgres, MySQL, and MariaDB suites skip with a message unless their `TEST_*_URL` is set.
The `test:*` scripts start the containers and set it for you, or point at a server you
already have by exporting the variable yourself; without Docker they say so rather than
failing obscurely.

CI always sets all three, against service containers, and then reads the test report back and
fails the build if any engine's suite skipped instead of running. "Passing" can never quietly
mean SQLite only.

## Releasing

Publishing is automated. Do not run `npm publish` by hand.

1. Bump the version and commit it: `npm version patch` (or `minor` / `major`), which also
   creates the matching `vX.Y.Z` tag.
2. Push the commit and the tag: `git push --follow-tags`.

Pushing the tag, or publishing a GitHub Release, triggers `.github/workflows/publish.yml`. It
runs the full CI suite including the Postgres conformance tests, checks the tag against
`package.json`, and only then publishes with `npm publish --provenance`. The provenance
attestation is what produces the verified build-source badge on the npm page: it links the
published tarball to this repository, this commit, and the workflow that built it.

Authentication uses npm **trusted publishing**, so there is no `NPM_TOKEN` secret in this
repository. npm mints a short-lived, single-publish credential from the workflow's OIDC
identity. This depends on a Trusted Publisher configured on the npm package page (Settings
tab, or `npmjs.com/package/repolayer/access`) naming this repository and the `publish.yml`
workflow file. **Renaming that workflow file breaks the match** and publishes will start
failing until the npm-side configuration is updated to match.

Doing both, pushing a tag and cutting a Release from it, is safe. The second run notices the
version is already on npm and exits without republishing.

### Dist-tags

The workflow derives the npm dist-tag from the version being published rather than taking
npm's default, which is to move `latest` to whatever was published last regardless of whether
it is newer.

| version | published as | because |
|---|---|---|
| newer than the current `latest` | `latest` | the ordinary case |
| an older major than `latest` | `v<major>` | a backport must not drag `latest` down |
| any prerelease (`2.1.0-rc.1`) | `next` | an rc must not become the default install |

So a patch cut from a `1.x` maintenance branch after `2.0.0` is out publishes under `v1`, and
`npm install repolayer` keeps resolving to v2. Users on the old line ask for it by name:

```bash
npm install repolayer          # latest
npm install repolayer@v1       # the 1.x line
npm install repolayer@next     # prereleases
```

This also makes a release candidate safe to publish from `main`: push a `v2.0.0-rc.1` tag,
get feedback from anyone willing to try it, and nobody's existing install moves.

Only majors are compared, so a backport within the current major (`2.0.5` while `2.1.0` is
out) would still land on `latest`. A wrong dist-tag is recoverable without republishing:
`npm dist-tag add repolayer@2.0.0 latest`.
