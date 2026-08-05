-- The replayable, versioned, config-driven transform pipeline. A named
-- `transform_config` drives a `transform_run` that re-derives the corpus from
-- the immutable `raw_capture` rows under a NEW `generation` tag, without ever
-- re-fetching source or touching the 'live' generation's versions.

ALTER TABLE "knowledge"."version"
  ADD COLUMN IF NOT EXISTS "generation" text NOT NULL DEFAULT 'live';

-- Version numbering moves from per-document to per-(document, generation),
-- so a replay generation can mint its own v1 alongside the live document's
-- existing versions instead of colliding with them.
DROP INDEX IF EXISTS "knowledge"."version_document_version_uniq";

CREATE UNIQUE INDEX IF NOT EXISTS "version_document_generation_version_uniq"
  ON "knowledge"."version" ("document_id", "generation", "version");

CREATE TABLE IF NOT EXISTS "knowledge"."transform_config" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "name" text NOT NULL,
  "version" integer NOT NULL,
  "params" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "transform_config_tenant_name_version_uniq" UNIQUE ("tenant_id", "name", "version")
);

CREATE TABLE IF NOT EXISTS "knowledge"."transform_run" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "config_id" text NOT NULL REFERENCES "knowledge"."transform_config" ("id"),
  "scope" jsonb NOT NULL DEFAULT '{}',
  "generation" text NOT NULL,
  "status" text NOT NULL DEFAULT 'running',
  "raw_count" integer NOT NULL DEFAULT 0,
  "version_count" integer NOT NULL DEFAULT 0,
  "error" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "completed_at" timestamp,
  CONSTRAINT "transform_run_status_check" CHECK ("status" IN ('running', 'completed', 'failed'))
);

-- One run mints exactly one generation; resolving a generation's tuning
-- config at search time is a lookup on this uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS "transform_run_generation_uniq"
  ON "knowledge"."transform_run" ("generation");

CREATE INDEX IF NOT EXISTS "transform_run_tenant_config_idx"
  ON "knowledge"."transform_run" ("tenant_id", "config_id");
