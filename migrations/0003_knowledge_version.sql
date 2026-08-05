-- The versioned body of a knowledge.document. version is a monotonic int per
-- document; status tracks the version/supersede/deprecate lifecycle. Chunks
-- belong to a version_id and are never reused across versions.
--
-- Attribution ("who") lives here: created_by_principal_id + created_by_kind
-- (human/agent/system/adapter). The authority_* columns are a per-version
-- snapshot of the corroboration signals computed at capture time (never
-- recomputed retroactively) and consumed as a rank prior at search time.
CREATE TABLE IF NOT EXISTS "knowledge"."version" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "document_id" text NOT NULL REFERENCES "knowledge"."document" ("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "supersedes_version_id" text,
  "status" text NOT NULL DEFAULT 'active',
  "content_hash" text NOT NULL,
  "occurred_at" timestamp NOT NULL,
  "ingested_at" timestamp NOT NULL DEFAULT now(),
  "deprecated_at" timestamp,
  "deprecated_reason" text,
  "created_by_principal_id" text,
  "created_by_kind" text NOT NULL,
  "generator_agent_id" text,
  "authority" real NOT NULL DEFAULT 0,
  "actor_count" integer NOT NULL DEFAULT 1,
  "has_social_signal" boolean NOT NULL DEFAULT false,
  "source_class" text NOT NULL DEFAULT 'native',
  CONSTRAINT "version_status_check" CHECK (
    "status" IN ('active', 'superseded', 'deprecated', 'archived', 'tombstoned')
  ),
  CONSTRAINT "version_created_by_kind_check" CHECK (
    "created_by_kind" IN ('human', 'agent', 'system', 'adapter')
  ),
  CONSTRAINT "version_source_class_check" CHECK (
    "source_class" IN ('native', 'thread', 'channel', 'call', 'record')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "version_document_version_uniq"
  ON "knowledge"."version" (
    "document_id",
    "version"
  );

CREATE INDEX IF NOT EXISTS "version_document_status_idx"
  ON "knowledge"."version" (
    "document_id",
    "status"
  );
