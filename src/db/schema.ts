import {
  boolean,
  customType,
  integer,
  jsonb,
  pgSchema,
  real,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/** Postgres schema owned by this package — never public. */
export const KNOWLEDGE_SCHEMA = "knowledge";

export const knowledgeSchema = pgSchema(KNOWLEDGE_SCHEMA);

// No built-in `bytea` helper in drizzle-orm/pg-core; raw_capture.raw_bytes
// holds non-textual raw payloads (binary source formats) as a Buffer.
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const knowledgeDocument = knowledgeSchema.table(
  "document",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    adapter: text("adapter").notNull(),
    externalRef: text("external_ref").notNull(),
    visibilityMode: text("visibility_mode").notNull(),
    visibilityPrincipalIds: jsonb("visibility_principal_ids"),
    visibilitySourceAcl: jsonb("visibility_source_acl"),
    attributes: jsonb("attributes").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("document_tenant_adapter_external_ref_uniq").on(
      t.tenantId,
      t.adapter,
      t.externalRef,
    ),
  ],
);

export const knowledgeVersion = knowledgeSchema.table(
  "version",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    documentId: text("document_id")
      .notNull()
      .references(() => knowledgeDocument.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    supersedesVersionId: text("supersedes_version_id"),
    status: text("status").notNull().default("active"),
    contentHash: text("content_hash").notNull(),
    occurredAt: timestamp("occurred_at").notNull(),
    ingestedAt: timestamp("ingested_at").notNull().defaultNow(),
    deprecatedAt: timestamp("deprecated_at"),
    deprecatedReason: text("deprecated_reason"),
    createdByPrincipalId: text("created_by_principal_id"),
    createdByKind: text("created_by_kind").notNull(),
    generatorAgentId: text("generator_agent_id"),
    authority: real("authority").notNull().default(0),
    actorCount: integer("actor_count").notNull().default(1),
    hasSocialSignal: boolean("has_social_signal").notNull().default(false),
    sourceClass: text("source_class").notNull().default("native"),
    rawCaptureId: text("raw_capture_id").references(() => rawCapture.id),
    // Replay-generation tag — 'live' for the normal /capture path; a replay tags every
    // version it writes with its own transform_run id instead, so a replayed
    // corpus never collides with (or supersedes) the live one.
    generation: text("generation").notNull().default("live"),
  },
  (t) => [
    uniqueIndex("version_document_generation_version_uniq").on(
      t.documentId,
      t.generation,
      t.version,
    ),
    index("version_document_status_idx").on(t.documentId, t.status),
  ],
);

export const knowledgeChunk = knowledgeSchema.table(
  "chunk",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    versionId: text("version_id")
      .notNull()
      .references(() => knowledgeVersion.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => knowledgeDocument.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
    role: text("role"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("chunk_version_ordinal_uniq").on(t.versionId, t.ordinal),
  ],
);

export const knowledgeEntity = knowledgeSchema.table(
  "entity",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    kind: text("kind").notNull(),
    identifiers: jsonb("identifiers").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("entity_tenant_kind_idx").on(t.tenantId, t.kind)],
);

export const knowledgeEdge = knowledgeSchema.table(
  "edge",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    rel: text("rel").notNull(),
    fromType: text("from_type").notNull(),
    fromRef: text("from_ref").notNull(),
    toType: text("to_type").notNull(),
    toRef: text("to_ref").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("edge_from_idx").on(t.tenantId, t.fromType, t.fromRef),
    index("edge_to_idx").on(t.tenantId, t.toType, t.toRef),
  ],
);

// The raw-capture layer — the raw corpus: the exact incoming capture payload, persisted
// immutably before derivation so a later replay can re-derive under a
// different config without re-fetching source. Append-only; dedupe on
// (tenantId, sourceHash) reuses the existing row instead of inserting a
// duplicate.
export const rawCapture = knowledgeSchema.table(
  "raw_capture",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    adapter: text("adapter").notNull(),
    externalRef: text("external_ref").notNull(),
    fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
    contentType: text("content_type").notNull(),
    rawText: text("raw_text"),
    rawBytes: bytea("raw_bytes"),
    metadata: jsonb("metadata").notNull().default({}),
    sourceHash: text("source_hash").notNull(),
  },
  (t) => [
    uniqueIndex("raw_capture_tenant_source_hash_uniq").on(
      t.tenantId,
      t.sourceHash,
    ),
    index("raw_capture_tenant_adapter_external_ref_idx").on(
      t.tenantId,
      t.adapter,
      t.externalRef,
    ),
  ],
);

export const knowledgeEmbedModel = knowledgeSchema.table("embed_model", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  modelKey: text("model_key").notNull(),
  modelId: text("model_id").notNull(),
  dims: integer("dims").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// The replay pipeline — a named, versioned set of derivation + retrieval-tuning knobs a
// replay re-derives the corpus under. `params` holds the chunk/embed/rerank
// + retrieval-boost config (see src/core/schemas/transform.ts); unique on
// (tenant_id, name, version) so re-creating the same name mints a new
// version rather than colliding.
export const transformConfig = knowledgeSchema.table(
  "transform_config",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    params: jsonb("params").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("transform_config_tenant_name_version_uniq").on(
      t.tenantId,
      t.name,
      t.version,
    ),
  ],
);

// The replay pipeline — one execution of a transform_config against a (possibly filtered)
// slice of raw_capture. `generation` is this run's id, written onto every
// knowledge_version row it derives; unique so a generation always resolves
// back to exactly one run (and therefore one config) at search time.
export const transformRun = knowledgeSchema.table(
  "transform_run",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    configId: text("config_id")
      .notNull()
      .references(() => transformConfig.id),
    scope: jsonb("scope").notNull().default({}),
    generation: text("generation").notNull(),
    status: text("status").notNull().default("running"),
    rawCount: integer("raw_count").notNull().default(0),
    versionCount: integer("version_count").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (t) => [
    uniqueIndex("transform_run_generation_uniq").on(t.generation),
    index("transform_run_tenant_config_idx").on(t.tenantId, t.configId),
  ],
);
