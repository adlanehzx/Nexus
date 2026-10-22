-- Reservation of an Agent Core run per task attempt.
--
-- Additive: no existing table is modified. The uniqueness constraint is the
-- core of the migration — preventing two workers (e.g. when one acquires an
-- expired lease during a long call) from launching two runs for the same
-- task attempt. Without this constraint, application-level checks would allow
-- concurrent requests through.
--
-- No foreign key to users: the reservation must remain readable even if the
-- account is deleted, and `requireMissionGrant` refuses execution. A cascade
-- delete would silently erase the audit trail of what was executed.
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
