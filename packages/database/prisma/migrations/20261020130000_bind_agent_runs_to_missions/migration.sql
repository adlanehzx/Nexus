-- La mission d'origine d'un run Agent Core.
--
-- Additive et nullable : les runs existants ont tous ete lances par une
-- personne, et doivent le rester. L'index sert la verification de portee d'une
-- assertion de mission, qui lit par (mission, proprietaire).
ALTER TABLE "agent_run_snapshots" ADD COLUMN "missionExternalKey" VARCHAR(128);

CREATE INDEX "agent_run_snapshots_missionExternalKey_idx"
    ON "agent_run_snapshots"("missionExternalKey");
