CREATE TABLE "agent_run_snapshots" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "startTime" TIMESTAMPTZ(3) NOT NULL,
    "state" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "agent_run_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_run_snapshots_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "agent_run_snapshots_userId_startTime_idx" ON "agent_run_snapshots"("userId", "startTime" DESC);
CREATE INDEX "agent_run_snapshots_status_idx" ON "agent_run_snapshots"("status");
