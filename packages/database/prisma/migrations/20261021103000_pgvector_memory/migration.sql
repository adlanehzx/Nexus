-- Recherche sémantique locale indexée. L'image PostgreSQL NEXUS embarque
-- l'extension ; aucune API distante ni clé n'intervient.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "memories"
  ADD COLUMN "embedding_vector" vector(384);

CREATE INDEX "memories_embedding_vector_hnsw_idx"
  ON "memories"
  USING hnsw ("embedding_vector" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
