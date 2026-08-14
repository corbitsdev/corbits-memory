-- Capture feed: monotonic commit marker for exactly-once pull (CL-5868).
-- feed_seq doubles as the Phase-2 outbox ordering key (design only; no push).

ALTER TABLE "memory"."version"
  ADD COLUMN IF NOT EXISTS "feed_seq" bigserial;

-- Live-generation drain path: tenant + generation + cursor.
CREATE INDEX IF NOT EXISTS "version_feed_seq_idx"
  ON "memory"."version" ("tenant_id", "generation", "feed_seq");
