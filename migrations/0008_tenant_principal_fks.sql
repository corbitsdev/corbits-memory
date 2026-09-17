-- Bind every memory.* tenant_id/principal_id column to Interchange's control
-- plane with a real foreign key, so a document/version/chunk/entity/edge/
-- capture/model/config/run can never name a tenant or principal that does
-- not exist. Tenant deletion cascades through this package's data;
-- principal deletion cascades only the attribution column it owns
-- (memory.version.created_by_principal_id), never a whole tenant's memory.

ALTER TABLE "memory"."document"
  ADD CONSTRAINT "document_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE CASCADE;

ALTER TABLE "memory"."version"
  ADD CONSTRAINT "version_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE CASCADE;

ALTER TABLE "memory"."version"
  ADD CONSTRAINT "version_created_by_principal_id_fkey"
  FOREIGN KEY ("created_by_principal_id") REFERENCES "public"."principal"("id") ON DELETE CASCADE;

ALTER TABLE "memory"."chunk"
  ADD CONSTRAINT "chunk_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE CASCADE;

ALTER TABLE "memory"."entity"
  ADD CONSTRAINT "entity_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE CASCADE;

ALTER TABLE "memory"."edge"
  ADD CONSTRAINT "edge_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE CASCADE;

ALTER TABLE "memory"."raw_capture"
  ADD CONSTRAINT "raw_capture_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE CASCADE;

ALTER TABLE "memory"."embed_model"
  ADD CONSTRAINT "embed_model_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE CASCADE;

ALTER TABLE "memory"."transform_config"
  ADD CONSTRAINT "transform_config_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE CASCADE;

ALTER TABLE "memory"."transform_run"
  ADD CONSTRAINT "transform_run_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE CASCADE;
