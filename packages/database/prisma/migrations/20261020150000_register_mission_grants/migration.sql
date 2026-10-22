-- Registry of mission assertions.
--
-- Additive. This table provides a previously missing capability: revoking an
-- assertion before its expiration. Previously, `jti` identified assertions
-- without revocation checks, allowing compromised assertions to remain usable
-- for 24 hours.
--
-- No foreign key to users: the registry is an audit trace of issued grants,
-- and must survive account deletion. `requireMissionGrant` then refuses
-- execution by verifying separately that the owner exists and is active.
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
    -- A retired grant always has a timestamp, and an active grant never
    -- does: status and timestamp must remain consistent.
    CONSTRAINT "mission_grants_retired_consistency" CHECK (
        ("status" = 'ACTIVE' AND "retiredAt" IS NULL)
        OR ("status" <> 'ACTIVE' AND "retiredAt" IS NOT NULL)
    )
);

CREATE INDEX "mission_grants_mission_status_idx"
    ON "mission_grants"("missionExternalKey", "status");
CREATE INDEX "mission_grants_user_status_idx" ON "mission_grants"("userId", "status");
CREATE INDEX "mission_grants_expiresAt_idx" ON "mission_grants"("expiresAt");
