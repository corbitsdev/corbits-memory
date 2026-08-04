# Contributing

Thanks for considering a contribution to Corbits Memory.

## Running it locally

```bash
git clone https://github.com/corbitsdev/corbits-memory.git
cd corbits-memory
docker compose up -d   # pgvector Postgres on localhost:5434
cp .env.example .env    # edit as needed — see README.md's quickstart
bun install
bun run db:setup         # applies migrations/*.sql, idempotent
bun run dev               # bun --watch src/server.ts
```

Requires Bun 1.2+. See `README.md` for the full quickstart including a
zero-cost local embedding endpoint (Ollama), and `IMPLEMENTATION.md` for how
the pieces fit together.

## Running the tests

```bash
bun run typecheck && bun run test
```

- `bun run test` runs the unit suite (`bun test ./src`) — every `core/*`
  module, most services, and the route layer have colocated `*.test.ts`
  files. It needs no external services.
- `bun run test:coverage` runs the same suite with lcov + text coverage
  reports.
- `bun run test:e2e` runs the integration suite (`bun test ./e2e`) — files
  under the top-level `e2e/` directory drive the full stack against a
  **real** pgvector Postgres and a **real** embedding endpoint. It needs both
  reachable:
  - `TEST_DATABASE_URL` (defaults to the `docker compose` connection string)
  - `TEST_EMBED_BASE_URL` / `TEST_EMBED_MODEL` (default to a local Ollama at
    `http://localhost:11434` / `nomic-embed-text`)

  If either is unreachable, the affected tests skip loudly with a logged
  reason rather than failing. If you're changing anything in the capture or
  search pipeline, run this suite with both dependencies up before opening a
  PR.

`bun run typecheck` (`tsc --noEmit`) must be clean before any commit.

## Branch and PR conventions

- Branch off `main`; open PRs against `main`.
- Keep PRs scoped to one logical change — a mix of an unrelated refactor and a
  feature makes review slower, not faster.
- Describe *why* the change is needed in the PR description, not just what
  changed; link any relevant issue.
- Make sure `bun run typecheck && bun run test` pass before requesting review.

## Commit messages

- Present tense, imperative mood: "Add X", "Fix Y", "Harden Z" — not "Added"
  or "Fixes".
- No issue-tracker ticket references (e.g. `CL-1234`) in commit messages,
  code, or comments — commit messages should be self-explanatory without an
  external ticket.
- One logical change per commit where practical; a commit message describes
  the change, not the task that produced it.

## Contributor License Agreement

Contributions require agreeing to the project's CLA — see `CLA.md`. The CLA
bot will comment on your first PR with instructions if you haven't signed
yet.
