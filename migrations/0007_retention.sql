-- Retention classes + lifecycle write paths (CL-5871).
-- Orthogonal to temporal_class (ranking) and status (active/deprecated/…).

ALTER TABLE "memory"."version"
  ADD COLUMN IF NOT EXISTS "retention_class" text NOT NULL DEFAULT 'standard';

ALTER TABLE "memory"."version"
  DROP CONSTRAINT IF EXISTS "version_retention_class_check";

ALTER TABLE "memory"."version"
  ADD CONSTRAINT "version_retention_class_check"
  CHECK ("retention_class" IN ('durable', 'standard', 'ephemeral', 'source_only'));

CREATE INDEX IF NOT EXISTS "version_retention_ephemeral_idx"
  ON "memory"."version" ("tenant_id", "retention_class", "valid_until")
  WHERE "retention_class" = 'ephemeral';
