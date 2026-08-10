# Schema / migrations — PR #31 round 2 (HEAD `6189b56`)

## Summary

Migrations and Drizzle schema consistently use `"memory".…` with short table
names (`document`, `version`, `chunk`, `edge`, …). Config prefers DATABASE_URL.
One application raw-SQL path still names the pre-rename edge table.

## Critical

1. **App SQL vs migration mismatch:** `search.ts:537` uses `knowledge_edge`;
   migrations create `"memory"."edge"`. Dense entity filter is broken on any
   real Postgres.

## High

2. **No upgrade path** from prior `knowledge` schema installs — CHANGELOG says
   fresh-only. Correct if intentional; add a short ops note (RENAME SCHEMA +
   RENAME tables) if anyone already applied old branch migrations.

3. **Migration filenames** still `0002_knowledge_baseline.sql` etc. Content is
   memory.*; confusing for operators grepping filenames. Optional rename of
   files is risky if migration ledger already records names — leave filenames,
   fix comments at top of 0002.

## Medium

4. **`0001_extensions.sql`** must create schema `memory` before 0002 — verify
   CREATE SCHEMA IF NOT EXISTS memory (assumed present; was part of rename).
5. **`archived_live_model_key`** text, no FK to embed_model — intentional
   (model row may be demoted/deleted); demote fails closed if key missing.
6. **embed_model ON CONFLICT** updates dims/model_id without status change —
   correct for ensure.
7. **CHECK/arktype lockstep** covered by `enums.lockstep.test.ts` — good.
8. **Internal FKs** document ← version ← chunk; edge/entity free of control-
   plane FKs — matches AGENTS.md.
9. **DATABASE_URL resolution** order correct; tests cover prefer / fallback /
   throw.

## Low

10. Index names dropped `knowledge_` prefix — good.
11. Dynamic embedding tables: FK to memory.chunk; tenant_id column; no per-
    tenant table isolation (by design).

## Config

| Source | Behavior |
|--------|----------|
| `memory.databaseUrl` on config | Programmatic hosts |
| `DATABASE_URL` | Preferred env |
| `KNOWLEDGE_DATABASE_URL` | Deprecated alias |
| Neither | throw |

## Ranked defects

1. Critical: raw SQL `knowledge_edge`
2. High: document upgrade path or confirm zero external installs
3. Medium: 0002 file header still says “knowledge plane”
4. Low: TS knowledge* symbols / comment rot
