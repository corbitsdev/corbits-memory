# Neckbeard — PR #31 round 2 (HEAD `6189b56`)

## Real bugs hiding as nits

1. **`knowledge_edge` in raw SQL** (`search.ts:537`) — not a naming nit. **Bug.**
2. **search.test.ts still accepts `FROM knowledge_embed_model`** as a success
   path for mocks (`search.test.ts:237, 412`). Teaches the wrong table name;
   should only match `"memory"."embed_model"`.

## Naming debt inventory (cosmetic unless noted)

| Residue | Severity |
|---------|----------|
| `knowledgeDocument`, `knowledgeVersion`, `knowledgeChunk`, `knowledgeEdge`, `knowledgeEntity`, `knowledgeEmbedModel` exports | Cosmetic / API-internal |
| `KNOWLEDGE_SCHEMA` deprecated alias | OK transitional |
| `migrations/0002_knowledge_baseline.sql` filename | Cosmetic; content correct |
| Comments `knowledge.version`, `knowledge.embed_model` | Doc rot |
| Id prefixes `kver`, `kdoc` | Cosmetic |
| grant-tags test still uses `knowledge.project:ke` as a free-form tag | Fine (host tags) |
| CHANGELOG “Postgres schema name remains knowledge” removed; good | — |

## Nits

- Dual match in tests for old embed_model table should die with the rename.
- `### Previously` in CHANGELOG is nonstandard Keep-a-Changelog structure.
- Package still says “knowledge plane” in a few comments (`config.ts` FTS).
- `openTarget` comment still says “generic knowledge doc” (`search.ts:156`).

## What not to rewrite

Do not rename all `knowledge*` TS symbols in this PR. Ship the SQL fix and
stop. A bulk rename PR with codemod is fine later.
