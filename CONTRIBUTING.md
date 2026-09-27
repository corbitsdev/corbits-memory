# Contributing

## Development

```sh
bun install
bun run check
```

`bun run check` runs typecheck, lint, format check and unit tests. `bun run format` rewrites the tree.

Contributors sign the [CLA](CLA.md) on their first PR; the CLA bot explains how.

`bun run test:e2e` drives the mounted routes and migrations against a real pgvector Postgres. `docker compose up -d` starts one on `localhost:5434` (plus Ollama for embeddings and a TEI reranker for manual runs), then run `TEST_DATABASE_URL=postgres://memory:memory-dev-password@localhost:5434/memory bun run test:e2e`. Each suite creates and drops its own database, and the suites skip when `TEST_DATABASE_URL` is unset. `cp .env.example .env` and `bun run db:setup` apply the schema for manual runs. `bun run test:coverage` reports lcov and text coverage over `src/` and `e2e/`.

## Migrations

`runMemoryMigrations` replays every file in `migrations/` on each run, so every file must be idempotent. Never change a shipped file's effect on an existing database: a changed constraint or a new column goes in a new numbered file, because a guarded `ADD CONSTRAINT` keeps the old definition.

## Commit messages

Commit subjects and PR titles follow [Conventional Commits](https://www.conventionalcommits.org): `feat`, `fix`, `refactor`, `test`, `docs`, `build`, `ci`, `perf`, and `chore(release): x.y.z` for releases.
Add `!` only for public API breaks: removed or renamed exports, changed signatures, newly required params. Peer and dependency range changes are `build(deps):` with no `!`.
Keep subjects imperative, lowercase after the colon, 72 characters or less, and free of ticket IDs.
Every PR links its issue with a `Closes <issue id>` line in the PR body.

## Releasing

Releases are manual. On a clean, up-to-date `main`:

```sh
npm version <patch|minor> -m "chore(release): %s"
git push --follow-tags
gh release create "v$(node -p 'require("./package.json").version')" --generate-notes
npm publish
```

Bump minor only for breaking API changes; everything else is a patch. `prepack` builds `dist/` from the tagged commit.
