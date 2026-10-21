-- Tickets d'appairage à usage unique.
--
-- Migration strictement additive : une table neuve, aucune colonne touchée,
-- aucune donnée réécrite. Elle peut donc s'appliquer sur une installation
-- vivante sans fenêtre d'arrêt, et un retour arrière se limite à un DROP.
--
-- `code_hash` est unique : l'unicité d'un code est une propriété de sécurité,
-- et la faire tenir par la base vaut mieux que par la discipline de l'appelant.
CREATE TABLE "device_pairing_tickets" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "deviceId" UUID,
    "label" VARCHAR(120),

    CONSTRAINT "device_pairing_tickets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "device_pairing_tickets_codeHash_key" ON "device_pairing_tickets"("codeHash");
CREATE INDEX "device_pairing_tickets_userId_createdAt_idx" ON "device_pairing_tickets"("userId", "createdAt");
CREATE INDEX "device_pairing_tickets_expiresAt_idx" ON "device_pairing_tickets"("expiresAt");
