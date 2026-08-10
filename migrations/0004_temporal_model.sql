-- Temporal model: ranking class + validity window on version.
-- See docs/TEMPORAL.md. No asserted_at — occurred_at is effective time;
-- ingested_at is when the memory plane learned the content.

ALTER TABLE "memory"."version"
  ADD COLUMN IF NOT EXISTS "temporal_class" text NOT NULL DEFAULT 'event';

ALTER TABLE "memory"."version"
  DROP CONSTRAINT IF EXISTS "version_temporal_class_check";

ALTER TABLE "memory"."version"
  ADD CONSTRAINT "version_temporal_class_check"
    CHECK ("temporal_class" IN ('event', 'deadline', 'state', 'lesson'));

ALTER TABLE "memory"."version"
  ADD COLUMN IF NOT EXISTS "valid_from" timestamp;

ALTER TABLE "memory"."version"
  ADD COLUMN IF NOT EXISTS "valid_until" timestamp;

-- Distilled claims (inferred provenance) default to state ranking.
UPDATE "memory"."version"
  SET "temporal_class" = 'state'
  WHERE "provenance" = 'inferred'
    AND "temporal_class" = 'event';
