-- The stable logical row for a captured source (an artifact, task, workflow
-- run, memory item, or external adapter pull). Deduped by the source-adapter
-- connect key (tenant_id, adapter, external_ref); re-ingest of an unchanged
-- content_hash bumps last_seen_at and creates no new version.
--
-- Identity/ACL lives here: tenant_id scopes every query; visibility_mode +
-- the two visibility_* columns are the self-contained ACL the caller passes.
-- tenant_id is plain text (no FK into control-plane tables).
CREATE TABLE IF NOT EXISTS "knowledge"."document" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "adapter" text NOT NULL,
  "external_ref" text NOT NULL,
  "visibility_mode" text NOT NULL,
  "visibility_principal_ids" jsonb,
  "visibility_source_acl" jsonb,
  "attributes" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "last_seen_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "document_visibility_mode_check" CHECK (
    "visibility_mode" IN ('tenant', 'principals', 'source_acl', 'private')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "document_tenant_adapter_external_ref_uniq"
  ON "knowledge"."document" (
    "tenant_id",
    "adapter",
    "external_ref"
  );
