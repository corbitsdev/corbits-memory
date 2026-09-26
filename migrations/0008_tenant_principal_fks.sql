-- Bind every memory.* tenant_id/principal_id column to Interchange's control
-- plane with a real foreign key, so a document/version/chunk/entity/edge/
-- capture/model/config/run can never name a tenant or principal that does
-- not exist. Tenant deletion cascades through this package's data;
-- principal deletion cascades only the attribution column it owns
-- (memory.version.created_by_principal_id), never a whole tenant's memory.
-- Each constraint is added only when missing, so re-running is a no-op; a
-- constraint that points at a different host schema fails the replay loudly.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'document_tenant_id_fkey' AND conrelid = '"memory"."document"'::regclass
      AND confrelid = '"public"."tenant"'::regclass
  ) THEN
    ALTER TABLE "memory"."document"
      ADD CONSTRAINT "document_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'version_tenant_id_fkey' AND conrelid = '"memory"."version"'::regclass
      AND confrelid = '"public"."tenant"'::regclass
  ) THEN
    ALTER TABLE "memory"."version"
      ADD CONSTRAINT "version_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'version_created_by_principal_id_fkey' AND conrelid = '"memory"."version"'::regclass
      AND confrelid = '"public"."principal"'::regclass
  ) THEN
    ALTER TABLE "memory"."version"
      ADD CONSTRAINT "version_created_by_principal_id_fkey"
      FOREIGN KEY ("created_by_principal_id") REFERENCES "public"."principal"("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chunk_tenant_id_fkey' AND conrelid = '"memory"."chunk"'::regclass
      AND confrelid = '"public"."tenant"'::regclass
  ) THEN
    ALTER TABLE "memory"."chunk"
      ADD CONSTRAINT "chunk_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'entity_tenant_id_fkey' AND conrelid = '"memory"."entity"'::regclass
      AND confrelid = '"public"."tenant"'::regclass
  ) THEN
    ALTER TABLE "memory"."entity"
      ADD CONSTRAINT "entity_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'edge_tenant_id_fkey' AND conrelid = '"memory"."edge"'::regclass
      AND confrelid = '"public"."tenant"'::regclass
  ) THEN
    ALTER TABLE "memory"."edge"
      ADD CONSTRAINT "edge_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'raw_capture_tenant_id_fkey' AND conrelid = '"memory"."raw_capture"'::regclass
      AND confrelid = '"public"."tenant"'::regclass
  ) THEN
    ALTER TABLE "memory"."raw_capture"
      ADD CONSTRAINT "raw_capture_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'embed_model_tenant_id_fkey' AND conrelid = '"memory"."embed_model"'::regclass
      AND confrelid = '"public"."tenant"'::regclass
  ) THEN
    ALTER TABLE "memory"."embed_model"
      ADD CONSTRAINT "embed_model_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transform_config_tenant_id_fkey' AND conrelid = '"memory"."transform_config"'::regclass
      AND confrelid = '"public"."tenant"'::regclass
  ) THEN
    ALTER TABLE "memory"."transform_config"
      ADD CONSTRAINT "transform_config_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transform_run_tenant_id_fkey' AND conrelid = '"memory"."transform_run"'::regclass
      AND confrelid = '"public"."tenant"'::regclass
  ) THEN
    ALTER TABLE "memory"."transform_run"
      ADD CONSTRAINT "transform_run_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE CASCADE;
  END IF;
END $$;
