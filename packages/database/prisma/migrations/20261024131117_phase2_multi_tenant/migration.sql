-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'HOSTED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_memberships" (
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("organizationId","userId")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_memberships" (
    "organizationId" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_memberships_pkey" PRIMARY KEY ("organizationId","teamId","userId")
);

-- CreateTable
CREATE TABLE "organization_identity_providers" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "protocol" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_identity_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_quotas" (
    "organizationId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "limit" BIGINT NOT NULL,
    "used" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_quotas_pkey" PRIMARY KEY ("organizationId","key")
);

-- CreateTable
CREATE TABLE "mission_access_grants" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "missionId" TEXT NOT NULL,
    "principalType" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mission_access_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_usage_records" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "costMicrounits" BIGINT,
    "official" BOOLEAN NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_installations" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "installationId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fleet_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_collaboration_events" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "channelId" TEXT NOT NULL,
    "actorUserId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_collaboration_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_artifacts" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "missionId" TEXT NOT NULL,
    "artifactKey" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "organization_memberships_userId_organizationId_idx" ON "organization_memberships"("userId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "teams_organizationId_name_key" ON "teams"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "teams_organizationId_id_key" ON "teams"("organizationId", "id");

-- CreateIndex
CREATE INDEX "team_memberships_organizationId_userId_idx" ON "team_memberships"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "organization_identity_providers_organizationId_id_idx" ON "organization_identity_providers"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_identity_providers_organizationId_protocol_iss_key" ON "organization_identity_providers"("organizationId", "protocol", "issuer");

-- CreateIndex
CREATE INDEX "mission_access_grants_organizationId_missionId_idx" ON "mission_access_grants"("organizationId", "missionId");

-- CreateIndex
CREATE UNIQUE INDEX "mission_access_grants_organizationId_missionId_principalTyp_key" ON "mission_access_grants"("organizationId", "missionId", "principalType", "principalId", "permission");

-- CreateIndex
CREATE INDEX "billing_usage_records_organizationId_occurredAt_idx" ON "billing_usage_records"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "fleet_installations_organizationId_status_idx" ON "fleet_installations"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "fleet_installations_organizationId_installationId_key" ON "fleet_installations"("organizationId", "installationId");

-- CreateIndex
CREATE INDEX "organization_collaboration_events_organizationId_channelId__idx" ON "organization_collaboration_events"("organizationId", "channelId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "organization_collaboration_events_organizationId_channelId__key" ON "organization_collaboration_events"("organizationId", "channelId", "sequence");

-- CreateIndex
CREATE INDEX "organization_artifacts_organizationId_missionId_idx" ON "organization_artifacts"("organizationId", "missionId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_artifacts_organizationId_missionId_artifactKey_key" ON "organization_artifacts"("organizationId", "missionId", "artifactKey");

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_organizationId_teamId_fkey" FOREIGN KEY ("organizationId", "teamId") REFERENCES "teams"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_identity_providers" ADD CONSTRAINT "organization_identity_providers_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_quotas" ADD CONSTRAINT "organization_quotas_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_access_grants" ADD CONSTRAINT "mission_access_grants_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_usage_records" ADD CONSTRAINT "billing_usage_records_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_installations" ADD CONSTRAINT "fleet_installations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_collaboration_events" ADD CONSTRAINT "organization_collaboration_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_artifacts" ADD CONSTRAINT "organization_artifacts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
