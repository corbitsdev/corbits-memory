-- Own Postgres schema for every knowledge-engine table. Host control-plane
-- tables stay in public; this package never collides with or adopts them.
CREATE SCHEMA IF NOT EXISTS "knowledge";

-- pgvector powers the dense retrieval channel. Per-model
-- "knowledge"."embedding_<key>" vector tables are created at runtime by the
-- embed-model activation path (dimensionality varies by model), not here.
CREATE EXTENSION IF NOT EXISTS vector;
