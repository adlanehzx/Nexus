-- Origin mission of an Agent Core run.
--
-- Additive and nullable: existing runs were all launched by a user,
-- and must remain so. The index serves scope verification of a
-- mission assertion, querying by (mission, owner).
ALTER TABLE "agent_run_snapshots" ADD COLUMN "missionExternalKey" VARCHAR(128);

CREATE INDEX "agent_run_snapshots_missionExternalKey_idx"
    ON "agent_run_snapshots"("missionExternalKey");
