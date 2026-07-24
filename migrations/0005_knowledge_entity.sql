-- A real-world thing (person, org, deal, ...) a document or chunk mentions.
-- Identity keys only (email, domain, ...) — not another copy of chunk text.
CREATE TABLE IF NOT EXISTS "knowledge_entity" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "kind" text NOT NULL,
  "identifiers" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "knowledge_entity_tenant_kind_idx"
  ON "knowledge_entity" (
    "tenant_id",
    "kind"
  );
