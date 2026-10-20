-- Registre des assertions de mission.
--
-- Additive. Ce que la table apporte est une capacite qui manquait : retirer une
-- assertion avant son expiration. Jusqu'ici le `jti` identifiait l'assertion
-- sans que personne ne le consulte, donc une assertion volee restait
-- exploitable vingt-quatre heures.
--
-- Pas de cle etrangere vers users : le registre est une trace de ce qui a ete
-- emis, et il doit survivre a la suppression d'un compte. C'est
-- `requireMissionGrant` qui refuse alors d'agir, en verifiant separement que le
-- proprietaire existe et est actif.
CREATE TYPE "MissionGrantState" AS ENUM ('ACTIVE', 'COMPLETED', 'REVOKED');

CREATE TABLE "mission_grants" (
    "id" UUID NOT NULL,
    "missionExternalKey" VARCHAR(128) NOT NULL,
    "userId" UUID NOT NULL,
    "service" VARCHAR(64) NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "MissionGrantState" NOT NULL DEFAULT 'ACTIVE',
    "retiredAt" TIMESTAMPTZ(3),
    CONSTRAINT "mission_grants_pkey" PRIMARY KEY ("id"),
    -- Un retrait porte toujours une date, et une assertion active n'en a
    -- jamais : l'etat et l'horodatage ne peuvent pas se contredire.
    CONSTRAINT "mission_grants_retired_consistency" CHECK (
        ("status" = 'ACTIVE' AND "retiredAt" IS NULL)
        OR ("status" <> 'ACTIVE' AND "retiredAt" IS NOT NULL)
    )
);

CREATE INDEX "mission_grants_mission_status_idx"
    ON "mission_grants"("missionExternalKey", "status");
CREATE INDEX "mission_grants_user_status_idx" ON "mission_grants"("userId", "status");
CREATE INDEX "mission_grants_expiresAt_idx" ON "mission_grants"("expiresAt");
