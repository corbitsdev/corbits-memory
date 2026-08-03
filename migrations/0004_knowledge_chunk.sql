-- An ordered slice of a knowledge.version's text, keyed by (version_id,
-- ordinal). text_fts is a generated tsvector for the lexical search channel —
-- no vector column here (per-model embedding tables are created separately,
-- since dimensionality varies by model).
CREATE TABLE IF NOT EXISTS "knowledge"."chunk" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "version_id" text NOT NULL REFERENCES "knowledge"."version" ("id") ON DELETE CASCADE,
  "document_id" text NOT NULL REFERENCES "knowledge"."document" ("id") ON DELETE CASCADE,
  "ordinal" integer NOT NULL,
  "text" text NOT NULL,
  "role" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "text_fts" tsvector GENERATED ALWAYS AS (to_tsvector('{{FTS_LANGUAGE}}', "text")) STORED
);

CREATE UNIQUE INDEX IF NOT EXISTS "chunk_version_ordinal_uniq"
  ON "knowledge"."chunk" (
    "version_id",
    "ordinal"
  );

CREATE INDEX IF NOT EXISTS "chunk_text_fts_idx"
  ON "knowledge"."chunk" USING GIN ("text_fts");
