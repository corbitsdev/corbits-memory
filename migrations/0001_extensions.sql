-- pgvector powers the dense retrieval channel. Per-model
-- "knowledge_embedding_<key>" vector tables are created at runtime by the
-- embed-model activation path (dimensionality varies by model), not here.
CREATE EXTENSION IF NOT EXISTS vector;
