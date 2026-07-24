-- The raw corpus, persisted immutably before derivation. The exact /capture
-- request payload (adapter + occurred_at + document) is stored here first, in
-- the same transaction as the derived document/version/chunk/edge rows, so a
-- later replay can re-derive under a different config without re-fetching
-- source. Append-only: rows are never updated or deleted by ingestion; dedupe
-- on (tenant_id, source_hash) reuses the existing row.
CREATE TABLE IF NOT EXISTS "raw_capture" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "adapter" text NOT NULL,
  "external_ref" text NOT NULL,
  "fetched_at" timestamp NOT NULL DEFAULT now(),
  "content_type" text NOT NULL,
  "raw_text" text,
  "raw_bytes" bytea,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  "source_hash" text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "raw_capture_tenant_source_hash_uniq"
  ON "raw_capture" ("tenant_id", "source_hash");

CREATE INDEX IF NOT EXISTS "raw_capture_tenant_adapter_external_ref_idx"
  ON "raw_capture" ("tenant_id", "adapter", "external_ref");

ALTER TABLE "knowledge_version"
  ADD COLUMN IF NOT EXISTS "raw_capture_id" text REFERENCES "raw_capture"("id");
