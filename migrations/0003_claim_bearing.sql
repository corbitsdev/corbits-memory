-- Claim-bearing substrate: provenance mode on version.
-- Edge rel / ref-type CHECKs already match the canonical set in 0002;
-- this migration only adds how-content-was-obtained (stated vs inferred).

ALTER TABLE "memory"."version"
  ADD COLUMN IF NOT EXISTS "provenance" text NOT NULL DEFAULT 'unknown';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'version_provenance_check' AND conrelid = '"memory"."version"'::regclass
  ) THEN
    ALTER TABLE "memory"."version"
      ADD CONSTRAINT "version_provenance_check"
      CHECK ("provenance" IN ('stated', 'inferred', 'unknown'));
  END IF;
END $$;
