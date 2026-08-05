-- Which embedding model is active per tenant, and the dims it was discovered
-- at (never hard-coded). The per-model "knowledge"."embedding_<key>" vector
-- tables are runtime-managed by the single guarded activation path, not here.
CREATE TABLE IF NOT EXISTS "knowledge"."embed_model" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "model_key" text NOT NULL,
  "model_id" text NOT NULL,
  "dims" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "embed_model_tenant_model_key_uniq" UNIQUE ("tenant_id", "model_key")
);
