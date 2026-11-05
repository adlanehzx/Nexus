-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "description" VARCHAR(512),
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "description" VARCHAR(512),
    "repoUrl" VARCHAR(1024),
    "defaultBranch" VARCHAR(128) NOT NULL DEFAULT 'master',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_memberships" (
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" VARCHAR(32) NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_memberships_pkey" PRIMARY KEY ("workspaceId","userId")
);

-- CreateTable
CREATE TABLE "workspace_environments" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workspace_environments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_agents" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "description" VARCHAR(512),
    "provider" VARCHAR(64) NOT NULL,
    "modelId" VARCHAR(128) NOT NULL,
    "systemPrompt" TEXT,
    "toolsEnabled" TEXT[],
    "status" VARCHAR(32) NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_provider_accounts" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID,
    "provider" VARCHAR(64) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "authStatus" VARCHAR(32) NOT NULL DEFAULT 'unknown',
    "profileKey" VARCHAR(128) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "credentialRefId" UUID,
    "reliability" JSONB NOT NULL DEFAULT '{}',
    "cooldown" JSONB NOT NULL DEFAULT '{}',
    "sessionDir" VARCHAR(1024),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_provider_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential_references" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "encryptedData" TEXT NOT NULL,
    "iv" VARCHAR(64) NOT NULL,
    "authTag" VARCHAR(64) NOT NULL,
    "keyFingerprint" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "credential_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_missions" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "goal" TEXT NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'created',
    "currentVersion" INTEGER NOT NULL DEFAULT 0,
    "fencingToken" INTEGER NOT NULL DEFAULT 0,
    "activeLeaseHolder" VARCHAR(128),
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_missions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_mission_events" (
    "id" UUID NOT NULL,
    "missionId" UUID NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "version" INTEGER NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlationId" VARCHAR(128) NOT NULL,
    "causationId" VARCHAR(128),
    "payload" JSONB NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "tenant_mission_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_quota_policies" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "tier" VARCHAR(32) NOT NULL DEFAULT 'standard',
    "monthlyBudgetUsd" DECIMAL(10,2) NOT NULL DEFAULT 100.00,
    "hardLimitUsd" DECIMAL(10,2) NOT NULL DEFAULT 120.00,
    "tokenRateLimitPerMin" INTEGER NOT NULL DEFAULT 100000,
    "concurrentMissionsLimit" INTEGER NOT NULL DEFAULT 5,
    "alertThresholdPercent" INTEGER NOT NULL DEFAULT 80,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_quota_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_audit_events" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID,
    "userId" UUID,
    "action" VARCHAR(128) NOT NULL,
    "resourceType" VARCHAR(64) NOT NULL,
    "resourceId" VARCHAR(128) NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "ipAddress" VARCHAR(64),
    "userAgent" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workspaces_organizationId_idx" ON "workspaces"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_organizationId_slug_key" ON "workspaces"("organizationId", "slug");

-- CreateIndex
CREATE INDEX "projects_workspaceId_idx" ON "projects"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "projects_workspaceId_slug_key" ON "projects"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "workspace_memberships_userId_workspaceId_idx" ON "workspace_memberships"("userId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_environments_workspaceId_name_key" ON "workspace_environments"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_agents_workspaceId_name_key" ON "tenant_agents"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "tenant_provider_accounts_organizationId_provider_idx" ON "tenant_provider_accounts"("organizationId", "provider");

-- CreateIndex
CREATE INDEX "tenant_provider_accounts_workspaceId_idx" ON "tenant_provider_accounts"("workspaceId");

-- CreateIndex
CREATE INDEX "credential_references_organizationId_type_idx" ON "credential_references"("organizationId", "type");

-- CreateIndex
CREATE INDEX "tenant_missions_projectId_status_idx" ON "tenant_missions"("projectId", "status");

-- CreateIndex
CREATE INDEX "tenant_mission_events_missionId_timestamp_idx" ON "tenant_mission_events"("missionId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_mission_events_missionId_version_key" ON "tenant_mission_events"("missionId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_quota_policies_organizationId_key" ON "tenant_quota_policies"("organizationId");

-- CreateIndex
CREATE INDEX "tenant_audit_events_organizationId_createdAt_idx" ON "tenant_audit_events"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "tenant_audit_events_workspaceId_idx" ON "tenant_audit_events"("workspaceId");

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_environments" ADD CONSTRAINT "workspace_environments_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_agents" ADD CONSTRAINT "tenant_agents_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_provider_accounts" ADD CONSTRAINT "tenant_provider_accounts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_provider_accounts" ADD CONSTRAINT "tenant_provider_accounts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_provider_accounts" ADD CONSTRAINT "tenant_provider_accounts_credentialRefId_fkey" FOREIGN KEY ("credentialRefId") REFERENCES "credential_references"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_references" ADD CONSTRAINT "credential_references_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_missions" ADD CONSTRAINT "tenant_missions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_mission_events" ADD CONSTRAINT "tenant_mission_events_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "tenant_missions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_quota_policies" ADD CONSTRAINT "tenant_quota_policies_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_audit_events" ADD CONSTRAINT "tenant_audit_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reconcile tables missing from the pre-existing migration history.
-- CreateTable
CREATE TABLE "worktrees" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "path" VARCHAR(1024) NOT NULL,
    "branch" VARCHAR(255) NOT NULL,
    "headCommit" VARCHAR(40),
    "baseBranch" VARCHAR(255),
    "workspaceRoot" VARCHAR(1024) NOT NULL,
    "strategy" VARCHAR(32) NOT NULL DEFAULT 'isolated',
    "status" VARCHAR(32) NOT NULL DEFAULT 'active',
    "isDetached" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "worktrees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkpoints" (
    "id" UUID NOT NULL,
    "worktreeId" UUID,
    "threadId" VARCHAR(255) NOT NULL,
    "turnNumber" INTEGER NOT NULL,
    "commitHash" VARCHAR(40),
    "diffBlob" TEXT,
    "description" VARCHAR(500),
    "snapshotRoot" VARCHAR(1024),
    "createdBy" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_control_links" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "provider" VARCHAR(32) NOT NULL,
    "repoUrl" VARCHAR(1024) NOT NULL,
    "pullRequestNumber" INTEGER,
    "branch" VARCHAR(255) NOT NULL,
    "headSha" VARCHAR(40),
    "checksState" VARCHAR(32) NOT NULL DEFAULT 'unknown',
    "reviewState" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "watched" BOOLEAN NOT NULL DEFAULT false,
    "threadId" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "source_control_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_provider_configs" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "providerType" VARCHAR(64) NOT NULL,
    "modelId" VARCHAR(255) NOT NULL,
    "displayName" VARCHAR(255),
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "authSecretRef" VARCHAR(255),
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_provider_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "worktrees_userId_status_createdAt_idx" ON "worktrees"("userId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "worktrees_workspaceRoot_branch_idx" ON "worktrees"("workspaceRoot", "branch");

-- CreateIndex
CREATE INDEX "checkpoints_threadId_turnNumber_idx" ON "checkpoints"("threadId", "turnNumber");

-- CreateIndex
CREATE INDEX "checkpoints_worktreeId_idx" ON "checkpoints"("worktreeId");

-- CreateIndex
CREATE INDEX "source_control_links_userId_provider_repoUrl_idx" ON "source_control_links"("userId", "provider", "repoUrl");

-- CreateIndex
CREATE INDEX "source_control_links_threadId_idx" ON "source_control_links"("threadId");

-- CreateIndex
CREATE INDEX "agent_provider_configs_userId_providerType_idx" ON "agent_provider_configs"("userId", "providerType");

-- AddForeignKey
ALTER TABLE "worktrees" ADD CONSTRAINT "worktrees_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "worktrees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_control_links" ADD CONSTRAINT "source_control_links_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_provider_configs" ADD CONSTRAINT "agent_provider_configs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "agent_core_run_claims_mission_task_attempt_key" RENAME TO "agent_core_run_claims_missionExternalKey_taskKey_attemptId_key";

-- RenameIndex
ALTER INDEX "mission_grants_mission_status_idx" RENAME TO "mission_grants_missionExternalKey_status_idx";

-- RenameIndex
ALTER INDEX "mission_grants_user_status_idx" RENAME TO "mission_grants_userId_status_idx";
