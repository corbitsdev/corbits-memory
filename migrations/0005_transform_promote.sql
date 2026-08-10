-- Promote / demote bookkeeping for staged transform generations (CL-5872).
-- archived_live_generation holds the generation tag assigned to the prior
-- live corpus during promote, so demote can swap back without data loss.

ALTER TABLE "memory"."transform_run"
  ADD COLUMN IF NOT EXISTS "archived_live_generation" text,
  ADD COLUMN IF NOT EXISTS "promoted_at" timestamp with time zone;
