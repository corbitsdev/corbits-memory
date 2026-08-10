-- Promote / demote bookkeeping for staged transform generations (CL-5872).
-- archived_live_generation holds the generation tag assigned to the prior
-- live corpus during promote, so demote can swap back without data loss.
-- archived_live_model_key holds the pre-promote active embed model_key so
-- demote can restore dense search to the table that holds restored vectors.

ALTER TABLE "memory"."transform_run"
  ADD COLUMN IF NOT EXISTS "archived_live_generation" text,
  ADD COLUMN IF NOT EXISTS "archived_live_model_key" text,
  ADD COLUMN IF NOT EXISTS "promoted_at" timestamp with time zone;
