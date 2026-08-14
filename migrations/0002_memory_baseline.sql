-- Single baseline for the memory plane (grant-tag authz from day one).
-- Document access is access_tags + creator post-filter; no visibility_* columns.

CREATE TABLE IF NOT EXISTS "memory"."document" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "adapter" text NOT NULL,
  "external_ref" text NOT NULL,
  "access_tags" text[] NOT NULL DEFAULT '{}',
  "attributes" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "last_seen_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "document_tenant_adapter_external_ref_uniq"
  ON "memory"."document" ("tenant_id", "adapter", "external_ref");

CREATE TABLE IF NOT EXISTS "memory"."raw_capture" (
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
  ON "memory"."raw_capture" ("tenant_id", "source_hash");

CREATE INDEX IF NOT EXISTS "raw_capture_tenant_adapter_external_ref_idx"
  ON "memory"."raw_capture" ("tenant_id", "adapter", "external_ref");

CREATE TABLE IF NOT EXISTS "memory"."version" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "document_id" text NOT NULL REFERENCES "memory"."document" ("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "supersedes_version_id" text,
  "status" text NOT NULL DEFAULT 'active',
  "content_hash" text NOT NULL,
  "occurred_at" timestamp NOT NULL,
  "ingested_at" timestamp NOT NULL DEFAULT now(),
  "deprecated_at" timestamp,
  "deprecated_reason" text,
  "created_by_principal_id" text,
  "created_by_kind" text NOT NULL,
  "generator_agent_id" text,
  "authority" real NOT NULL DEFAULT 0,
  "actor_count" integer NOT NULL DEFAULT 1,
  "has_social_signal" boolean NOT NULL DEFAULT false,
  "source_class" text NOT NULL DEFAULT 'native',
  "raw_capture_id" text REFERENCES "memory"."raw_capture" ("id"),
  "generation" text NOT NULL DEFAULT 'live',
  CONSTRAINT "version_status_check"
    CHECK ("status" IN ('active', 'superseded', 'deprecated', 'archived', 'tombstoned')),
  CONSTRAINT "version_created_by_kind_check"
    CHECK ("created_by_kind" IN ('human', 'agent', 'system', 'adapter')),
  CONSTRAINT "version_source_class_check"
    CHECK ("source_class" IN ('native', 'imported', 'derived'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "version_document_generation_version_uniq"
  ON "memory"."version" ("document_id", "generation", "version");

CREATE INDEX IF NOT EXISTS "version_document_status_idx"
  ON "memory"."version" ("document_id", "status");

CREATE TABLE IF NOT EXISTS "memory"."chunk" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "version_id" text NOT NULL REFERENCES "memory"."version" ("id") ON DELETE CASCADE,
  "document_id" text NOT NULL REFERENCES "memory"."document" ("id") ON DELETE CASCADE,
  "ordinal" integer NOT NULL,
  "text" text NOT NULL,
  "role" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "chunk_version_ordinal_uniq"
  ON "memory"."chunk" ("version_id", "ordinal");

-- {{FTS_LANGUAGE}} is substituted by runMemoryMigrations from FTS_LANGUAGE
-- (or opts.ftsLanguage). Must match the language used at query time.
ALTER TABLE "memory"."chunk"
  ADD COLUMN IF NOT EXISTS "text_fts" tsvector
  GENERATED ALWAYS AS (to_tsvector('{{FTS_LANGUAGE}}', "text")) STORED;

CREATE INDEX IF NOT EXISTS "chunk_text_fts_idx"
  ON "memory"."chunk" USING GIN ("text_fts");

CREATE TABLE IF NOT EXISTS "memory"."entity" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "kind" text NOT NULL,
  "identifiers" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "entity_tenant_kind_idx"
  ON "memory"."entity" ("tenant_id", "kind");

CREATE TABLE IF NOT EXISTS "memory"."edge" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "rel" text NOT NULL,
  "from_type" text NOT NULL,
  "from_ref" text NOT NULL,
  "to_type" text NOT NULL,
  "to_ref" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "edge_rel_check"
    CHECK ("rel" IN (
      'mentions', 'about', 'authored_by', 'involves',
      'part_of', 'derived_from', 'supports', 'contradicts', 'supersedes'
    )),
  CONSTRAINT "edge_from_type_check"
    CHECK ("from_type" IN ('document', 'version', 'chunk', 'entity')),
  CONSTRAINT "edge_to_type_check"
    CHECK ("to_type" IN ('document', 'version', 'chunk', 'entity'))
);

CREATE INDEX IF NOT EXISTS "edge_from_idx"
  ON "memory"."edge" ("tenant_id", "from_type", "from_ref");

CREATE INDEX IF NOT EXISTS "edge_to_idx"
  ON "memory"."edge" ("tenant_id", "to_type", "to_ref");

CREATE TABLE IF NOT EXISTS "memory"."embed_model" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "model_key" text NOT NULL,
  "model_id" text NOT NULL,
  "dims" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "embed_model_status_check"
    CHECK ("status" IN ('active', 'retired'))
);

CREATE TABLE IF NOT EXISTS "memory"."transform_config" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "name" text NOT NULL,
  "version" integer NOT NULL,
  "params" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "transform_config_tenant_name_version_uniq"
    UNIQUE ("tenant_id", "name", "version")
);

CREATE TABLE IF NOT EXISTS "memory"."transform_run" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "config_id" text NOT NULL REFERENCES "memory"."transform_config" ("id"),
  "scope" jsonb NOT NULL DEFAULT '{}',
  "generation" text NOT NULL,
  "status" text NOT NULL DEFAULT 'running',
  "raw_count" integer NOT NULL DEFAULT 0,
  "version_count" integer NOT NULL DEFAULT 0,
  "error" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "completed_at" timestamp,
  CONSTRAINT "transform_run_status_check"
    CHECK ("status" IN ('running', 'completed', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "transform_run_generation_uniq"
  ON "memory"."transform_run" ("generation");

CREATE INDEX IF NOT EXISTS "transform_run_tenant_config_idx"
  ON "memory"."transform_run" ("tenant_id", "config_id");
