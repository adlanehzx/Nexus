CREATE TYPE "ScheduleGrantState" AS ENUM ('ACTIVE', 'REVOKED');

CREATE TABLE "schedule_grants" (
    "id" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "userId" UUID NOT NULL,
    "missionExternalKey" VARCHAR(128) NOT NULL,
    "scheduleId" UUID NOT NULL,
    "status" "ScheduleGrantState" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),
    CONSTRAINT "schedule_grants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "schedule_grants_revocation_consistent" CHECK (
      ("status" = 'ACTIVE' AND "revokedAt" IS NULL)
      OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "schedule_grants_tokenHash_key" ON "schedule_grants"("tokenHash");
CREATE UNIQUE INDEX "schedule_grants_scheduleId_key" ON "schedule_grants"("scheduleId");
CREATE INDEX "schedule_grants_userId_status_idx" ON "schedule_grants"("userId", "status");

ALTER TABLE "schedule_grants"
ADD CONSTRAINT "schedule_grants_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
