-- Provenance et recherche sémantique locale.
--
-- Le vecteur reste un tableau PostgreSQL afin que NEXUS fonctionne sur l'image
-- postgres officielle, sans rendre l'extension pgvector obligatoire. Le port
-- EmbeddingProvider permet de brancher pgvector ultérieurement sans changer le
-- modèle métier.
ALTER TABLE "memories"
  ADD COLUMN "sourceRunId" UUID,
  ADD COLUMN "sourceConversationId" UUID,
  ADD COLUMN "sourceMessageId" UUID,
  ADD COLUMN "sourceUri" TEXT,
  ADD COLUMN "contentHash" TEXT,
  ADD COLUMN "embedding" DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[]::DOUBLE PRECISION[],
  ADD COLUMN "embeddingModel" TEXT,
  ADD COLUMN "extractedAt" TIMESTAMPTZ(3);

-- Les lignes historiques reçoivent une empreinte stable compatible avec le
-- calcul applicatif. regexp_replace reproduit la normalisation des espaces ;
-- l'application gère en plus les accents pour les nouvelles écritures.
UPDATE "memories"
SET "contentHash" = md5(lower(trim(regexp_replace("content", '\s+', ' ', 'g'))));
ALTER TABLE "memories" ALTER COLUMN "contentHash" SET NOT NULL;

CREATE INDEX "memories_userId_contentHash_validUntil_idx"
  ON "memories"("userId", "contentHash", "validUntil");
CREATE INDEX "memories_sourceRunId_idx" ON "memories"("sourceRunId");
