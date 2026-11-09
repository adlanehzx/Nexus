-- Lab 1: configurable career autonomy and LinkedIn content management.
--
-- Additive only: one defaulted column on career_application_events (existing
-- rows become actor = 'owner', which is what they were), and new tables that
-- cascade on account deletion like the rest of the career domain.

-- CreateEnum
CREATE TYPE "LinkedInPostState" AS ENUM ('draft', 'awaiting_approval', 'scheduled', 'publishing', 'published', 'failed', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "LinkedInEngagementKind" AS ENUM ('reaction', 'comment');

-- CreateEnum
CREATE TYPE "LinkedInEngagementState" AS ENUM ('proposed', 'queued', 'executing', 'executed', 'failed', 'rejected', 'cancelled');

-- AlterTable
ALTER TABLE "career_application_events" ADD COLUMN     "actor" VARCHAR(32) NOT NULL DEFAULT 'owner';

-- CreateTable
CREATE TABLE "career_autonomy_settings" (
    "userId" UUID NOT NULL,
    "settings" JSONB NOT NULL,
    "autonomyActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "career_autonomy_settings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "linkedin_content_settings" (
    "userId" UUID NOT NULL,
    "settings" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "automationConsentAt" TIMESTAMPTZ(3),
    "automationConsentVersion" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "linkedin_content_settings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "linkedin_posts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "state" "LinkedInPostState" NOT NULL,
    "text" VARCHAR(3000) NOT NULL,
    "topic" VARCHAR(120),
    "visibility" VARCHAR(16) NOT NULL,
    "scheduledAt" TIMESTAMPTZ(3),
    "publishedAt" TIMESTAMPTZ(3),
    "externalId" VARCHAR(200),
    "failureReason" VARCHAR(400),
    "createdBy" VARCHAR(32) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "linkedin_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "linkedin_engagements" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "LinkedInEngagementKind" NOT NULL,
    "target" VARCHAR(500) NOT NULL,
    "reaction" VARCHAR(24),
    "text" VARCHAR(1250),
    "rationale" VARCHAR(400),
    "state" "LinkedInEngagementState" NOT NULL,
    "executeAfter" TIMESTAMPTZ(3),
    "executedAt" TIMESTAMPTZ(3),
    "executor" VARCHAR(64),
    "failureReason" VARCHAR(400),
    "createdBy" VARCHAR(32) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "linkedin_engagements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "linkedin_audit_events" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "actor" VARCHAR(32) NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "subjectType" VARCHAR(32) NOT NULL,
    "subjectId" UUID,
    "outcome" VARCHAR(16) NOT NULL,
    "summary" VARCHAR(400) NOT NULL,
    "context" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "linkedin_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "career_autonomy_settings_autonomyActive_idx" ON "career_autonomy_settings"("autonomyActive");

-- CreateIndex
CREATE INDEX "linkedin_content_settings_active_idx" ON "linkedin_content_settings"("active");

-- CreateIndex
CREATE INDEX "linkedin_posts_userId_state_scheduledAt_idx" ON "linkedin_posts"("userId", "state", "scheduledAt");

-- CreateIndex
CREATE INDEX "linkedin_posts_state_scheduledAt_idx" ON "linkedin_posts"("state", "scheduledAt");

-- CreateIndex
CREATE INDEX "linkedin_posts_userId_createdAt_idx" ON "linkedin_posts"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "linkedin_engagements_userId_state_executeAfter_idx" ON "linkedin_engagements"("userId", "state", "executeAfter");

-- CreateIndex
CREATE INDEX "linkedin_engagements_userId_executedAt_idx" ON "linkedin_engagements"("userId", "executedAt");

-- CreateIndex
CREATE UNIQUE INDEX "linkedin_engagements_userId_kind_target_key" ON "linkedin_engagements"("userId", "kind", "target");

-- CreateIndex
CREATE INDEX "linkedin_audit_events_userId_createdAt_idx" ON "linkedin_audit_events"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "career_autonomy_settings" ADD CONSTRAINT "career_autonomy_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linkedin_content_settings" ADD CONSTRAINT "linkedin_content_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linkedin_posts" ADD CONSTRAINT "linkedin_posts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linkedin_engagements" ADD CONSTRAINT "linkedin_engagements_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linkedin_audit_events" ADD CONSTRAINT "linkedin_audit_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A row cannot claim to be published / executed without the facts that prove
-- it: the UI must never show a success the database cannot back.
ALTER TABLE "linkedin_posts"
ADD CONSTRAINT "linkedin_posts_published_has_timestamp"
CHECK ("state" <> 'published' OR ("publishedAt" IS NOT NULL AND "externalId" IS NOT NULL));

ALTER TABLE "linkedin_engagements"
ADD CONSTRAINT "linkedin_engagements_executed_has_timestamp"
CHECK ("state" <> 'executed' OR "executedAt" IS NOT NULL);
