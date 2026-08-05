-- Lightweight graph structure between documents, entities, and native refs
-- (e.g. a principal) — never another copy of chunk text. This is the "series
-- of relations" every record can carry; relation-following ingestion writes
-- `mentions` edges here.
CREATE TABLE IF NOT EXISTS "knowledge"."edge" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "rel" text NOT NULL,
  "from_type" text NOT NULL,
  "from_ref" text NOT NULL,
  "to_type" text NOT NULL,
  "to_ref" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "edge_rel_check" CHECK (
    "rel" IN ('about', 'produced_by', 'links', 'parent', 'mentions', 'waiting_on')
  ),
  CONSTRAINT "edge_from_type_check" CHECK (
    "from_type" IN ('document', 'entity', 'native')
  ),
  CONSTRAINT "edge_to_type_check" CHECK (
    "to_type" IN ('document', 'entity', 'native')
  )
);

CREATE INDEX IF NOT EXISTS "edge_from_idx"
  ON "knowledge"."edge" (
    "tenant_id",
    "from_type",
    "from_ref"
  );

CREATE INDEX IF NOT EXISTS "edge_to_idx"
  ON "knowledge"."edge" (
    "tenant_id",
    "to_type",
    "to_ref"
  );
