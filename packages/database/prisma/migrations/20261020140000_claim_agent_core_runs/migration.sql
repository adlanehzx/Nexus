-- Reservation d'un run Agent Core par tentative de tache.
--
-- Additive : aucune table existante n'est touchee. La contrainte d'unicite est
-- le coeur de la migration — c'est elle qui empeche deux workers, dont l'un a
-- repris un bail expire pendant un appel long, de lancer deux runs pour le meme
-- travail. Sans contrainte, une verification applicative laisserait passer les
-- deux requetes concurrentes.
--
-- Pas de cle etrangere vers users : la reservation doit survivre a la lecture
-- meme si le compte disparait, et c'est `requireMissionGrant` qui refuse alors
-- d'agir. Une cascade effacerait silencieusement la trace de ce qui a tourne.
CREATE TABLE "agent_core_run_claims" (
    "id" UUID NOT NULL,
    "missionExternalKey" VARCHAR(128) NOT NULL,
    "taskKey" VARCHAR(128) NOT NULL,
    "attemptId" VARCHAR(128) NOT NULL,
    "runId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_core_run_claims_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_core_run_claims_mission_task_attempt_key"
    ON "agent_core_run_claims"("missionExternalKey", "taskKey", "attemptId");

CREATE INDEX "agent_core_run_claims_runId_idx" ON "agent_core_run_claims"("runId");
