-- Memory plane owns its own Postgres schema. Never pollutes public.
CREATE SCHEMA IF NOT EXISTS "memory";

-- pgvector for dense embeddings (cosine distance / HNSW).
CREATE EXTENSION IF NOT EXISTS vector;
