-- Provenance and local semantic search.
--
-- The vector remains a PostgreSQL array so NEXUS runs on official postgres
-- images without requiring pgvector. The EmbeddingProvider port allows
-- plugging in pgvector later without changing the domain model.
ALTER TABLE "memories"
  ADD COLUMN "sourceRunId" UUID,
  ADD COLUMN "sourceConversationId" UUID,
  ADD COLUMN "sourceMessageId" UUID,
  ADD COLUMN "sourceUri" TEXT,
  ADD COLUMN "contentHash" TEXT,
  ADD COLUMN "embedding" DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[]::DOUBLE PRECISION[],
  ADD COLUMN "embeddingModel" TEXT,
  ADD COLUMN "extractedAt" TIMESTAMPTZ(3);

-- Historical rows receive a stable fingerprint compatible with application
-- hashing. regexp_replace reproduces whitespace normalization; application logic
-- handles accent normalization for new writes.
UPDATE "memories"
SET "contentHash" = md5(lower(trim(regexp_replace("content", '\s+', ' ', 'g'))));
ALTER TABLE "memories" ALTER COLUMN "contentHash" SET NOT NULL;

CREATE INDEX "memories_userId_contentHash_validUntil_idx"
  ON "memories"("userId", "contentHash", "validUntil");
CREATE INDEX "memories_sourceRunId_idx" ON "memories"("sourceRunId");
