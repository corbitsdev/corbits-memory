# Changelog

All notable changes to `@corbits/memory` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-09-25

### Changed

- **Breaking:** `@intx/*`, `drizzle-orm`, `hono`, `hono-openapi` and
  `postgres` are peer dependencies; the host supplies them. `engines` is
  removed.
- **Breaking:** `createMemoryRoutes({ memory, requireGrant, callerResolver? })`
  returns the memory routes as a `Hono<TenantEnv>` sub-app with paths relative
  to its mount point; hosts mount it at `/api/tenants/:tenantId/memory`. It
  replaces `createMemory({ app, callerResolver })` and `registerMemoryRoutes`,
  and `RouteDeps` no longer carries `grants`. `createMemory` only builds the
  plane.
- **Breaking:** the package root exports only the public API. Internal
  services and helpers (transform, retention, feed, share materialization,
  corroboration, embed model registry, degrade metrics, FTS helpers), the test
  fakes, and `resolveGrantConfig` are no longer exported. The distiller stays
  at `@corbits/memory/distiller` and migrations at
  `@corbits/memory/migrations`.
- **Breaking:** `runMemoryMigrations(config, { schema, ftsLanguage })` takes
  the same `DBConfig` as Interchange `runMigrations` instead of a database
  URL. `schema` names the host schema holding Interchange's `tenant` and
  `principal` tables (the value passed to `runMigrations`, e.g. `"public"`);
  memory's tables stay in the `memory` schema. `ftsLanguage` is required, and
  the runner no longer reads `FTS_LANGUAGE` from the environment or accepts a
  `log` option.
- Every migration file is idempotent and replayed on each run, with a 5 s
  `lock_timeout`. The `memory._migrations` ledger is dropped.
- `MEMORY_GRANT_REQUIREMENTS` is read from `package.json`
  `interchange.grantRequirements`, now the only declaration.
  `MEMORY_CAPABILITY_IDS` is typed `string[]`.
- `prepack` runs `bun run build`.

### Upgrading from 0.1.0

- Call the new `runMemoryMigrations` once; it upgrades a 0.1.0 database in
  place with no data loss.
- After the upgrade, do not run 0.1.0 against the database: its ledger is
  gone, so there is no downgrade.

## [0.1.0] — 2026-09-25

First release on npm.

[0.2.0]: https://github.com/corbitsdev/corbits-memory/releases/tag/v0.2.0
[0.1.0]: https://www.npmjs.com/package/@corbits/memory/v/0.1.0
