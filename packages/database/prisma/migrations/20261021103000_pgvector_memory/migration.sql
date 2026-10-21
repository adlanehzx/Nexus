-- Indexed local semantic search. The NEXUS PostgreSQL image includes
-- the extension; no remote API or key is required.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "memories"
  ADD COLUMN "embedding_vector" vector(384);

CREATE INDEX "memories_embedding_vector_hnsw_idx"
  ON "memories"
  USING hnsw ("embedding_vector" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
