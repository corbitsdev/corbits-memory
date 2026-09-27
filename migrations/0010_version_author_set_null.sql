-- A removed principal must not delete the versions it authored: switch the
-- author foreign key from ON DELETE CASCADE to ON DELETE SET NULL. Replaced
-- only while it still cascades, so re-running is a no-op.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'version_created_by_principal_id_fkey' AND conrelid = '"memory"."version"'::regclass
      AND confdeltype = 'c'
  ) THEN
    ALTER TABLE "memory"."version"
      DROP CONSTRAINT "version_created_by_principal_id_fkey",
      ADD CONSTRAINT "version_created_by_principal_id_fkey"
      FOREIGN KEY ("created_by_principal_id") REFERENCES "public"."principal"("id") ON DELETE SET NULL;
  END IF;
END $$;
