-- Temporal model: ranking class + validity window on version.
-- See docs/TEMPORAL.md. No asserted_at — occurred_at is effective time;
-- ingested_at is when the memory plane learned the content.

-- The backfill runs only in the replay that adds the column, so distilled
-- claims (inferred provenance) written before this migration default to
-- state ranking exactly once; later inferred `event` rows are left alone.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'memory' AND table_name = 'version'
      AND column_name = 'temporal_class'
  ) THEN
    ALTER TABLE "memory"."version"
      ADD COLUMN "temporal_class" text NOT NULL DEFAULT 'event';
    UPDATE "memory"."version"
      SET "temporal_class" = 'state'
      WHERE "provenance" = 'inferred';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'version_temporal_class_check' AND conrelid = '"memory"."version"'::regclass
  ) THEN
    ALTER TABLE "memory"."version"
      ADD CONSTRAINT "version_temporal_class_check"
      CHECK ("temporal_class" IN ('event', 'deadline', 'state', 'lesson'));
  END IF;
END $$;

ALTER TABLE "memory"."version"
  ADD COLUMN IF NOT EXISTS "valid_from" timestamp;

ALTER TABLE "memory"."version"
  ADD COLUMN IF NOT EXISTS "valid_until" timestamp;

