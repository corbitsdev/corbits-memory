# Contributing

Thanks for considering a contribution to Corbits Memory.

## Running it locally

```bash
git clone https://github.com/corbitsdev/corbits-memory.git
cd corbits-memory
docker compose up -d   # pgvector Postgres on localhost:5434
cp .env.example .env    # edit as needed — see README.md's Reference
bun install
bun run db:setup        # applies migrations/*.sql, idempotent
bun run build           # compiles src/ to dist/, which the package publishes
```

Requires Bun 1.2+. `compose.yml` also runs a local Ollama for embeddings
(`docker compose exec ollama ollama pull nomic-embed-text`). Unit tests use
the in-repo `createFakeDocumentStore`/`createFakeSourceProvider` and need no
Postgres. See `IMPLEMENTATION.md` for how the pieces fit together.

## Running the tests

```bash
bun run typecheck && bun run test && bun run test:e2e
```

- `bun run test` runs the unit suite in `src/`; `bun run test:e2e` runs the
  end-to-end suite in `e2e/`. The end-to-end tests drive the mounted routes and migrations
  against a real pgvector Postgres: set `TEST_DATABASE_URL` to a server the
  tests can create and drop databases on (for `docker compose up -d`,
  `postgres://memory:memory-dev-password@localhost:5434/memory`). Each suite
  creates its own database and drops it afterwards. Without
  `TEST_DATABASE_URL` those suites skip.
- `bun run test:coverage` runs the unit suite with lcov + text coverage
  reports.

`bun run typecheck` (`tsc --noEmit`) must be clean before any commit.

## Migrations

`runMemoryMigrations` replays every file in `migrations/` on each run, so
every file must be idempotent. Never change a shipped file's effect on an
existing database: a changed constraint or a new column goes in a new
numbered file, because a guarded `ADD CONSTRAINT` keeps the old definition.

## Branch and PR conventions

- Branch off `main`; open PRs against `main`.
- Keep PRs scoped to one logical change — a mix of an unrelated refactor and a
  feature makes review slower, not faster.
- Describe _why_ the change is needed in the PR description, not just what
  changed; link any relevant issue.
- Make sure `bun run typecheck && bun run test` pass before requesting review.

## Contributor License Agreement

Contributions require agreeing to the project's CLA — see `CLA.md`. The CLA
bot will comment on your first PR with instructions if you haven't signed
yet.

## Commit messages

Commit subjects and PR titles follow [Conventional Commits](https://www.conventionalcommits.org): `feat`, `fix`, `refactor`, `test`, `docs`, `build`, `ci`, `perf`, and `chore(release): x.y.z` for releases.
Add `!` only for public API breaks: removed or renamed exports, changed signatures, newly required params. Peer and dependency range changes are `build(deps):` with no `!`.
Keep subjects imperative, lowercase after the colon, 72 characters or less, and free of ticket IDs.
No ticket IDs in code or comments either. One logical change per commit where practical; describe the change, not the task that produced it.
Every PR links its issue with a `Closes <issue id>` line in the PR body.
