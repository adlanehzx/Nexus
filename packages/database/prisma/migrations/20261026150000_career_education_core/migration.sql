-- Career and education core.
--
-- Additive: fourteen new enum types and eleven new tables, no change to any
-- existing column, constraint or index. An installation that never touches the
-- career routes is unaffected by this migration.
--
-- Three properties are enforced here rather than in application code, because
-- application code is not running when a process is killed mid-write:
--
--   * **Deduplication.** `career_opportunities` is unique on
--     (userId, fingerprint) and on (userId, canonicalUrl). Two concurrent
--     ingests of one posting cannot both insert; the loser gets a conflict and
--     merges provenance into the winner.
--   * **Exactly-once submission.** `career_submission_attempts` is unique on
--     (userId, idempotencyKey), and the key is derived from the application,
--     the payload and the approval. A retry after a crash reproduces the key
--     and is refused by the index.
--   * **One live approval.** A partial unique index allows at most one pending
--     confirmation per (userId, applicationId, purpose), so a second question
--     cannot be queued behind the first and answered by accident.
--
-- Owner isolation is structural: every table carries `userId` with a foreign
-- key to `users` and `ON DELETE CASCADE`. Deleting an account removes the whole
-- job search, which is the stated retention rule — this is the owner's personal
-- data, not an audit trail the platform needs to keep.
--
-- Enum values are the lowercase domain vocabulary of `@nexus/career` rather
-- than the upper-cased style of the older enums in this schema. The vocabulary
-- is the API contract: what a dashboard receives is what psql shows, with no
-- translation table to drift.

-- CreateEnum
CREATE TYPE "CareerOpportunityKind" AS ENUM ('phd', 'permanent_job', 'freelance');

-- CreateEnum
CREATE TYPE "CareerSourceKind" AS ENUM ('official_site', 'institutional_registry', 'aggregator', 'referral', 'manual_entry', 'unverified');

-- CreateEnum
CREATE TYPE "CareerApplicationState" AS ENUM ('discovered', 'shortlisted', 'drafting', 'awaiting_confirmation', 'approved', 'submitted', 'interview', 'offer', 'rejected', 'withdrawn', 'expired');

-- CreateEnum
CREATE TYPE "CareerDocumentKind" AS ENUM ('cv', 'cover_letter', 'research_statement', 'portfolio_note', 'reference_list');

-- CreateEnum
CREATE TYPE "CareerDeadlineKind" AS ENUM ('application_deadline', 'document_due', 'interview', 'decision_expected', 'follow_up');

-- CreateEnum
CREATE TYPE "CareerDeadlineState" AS ENUM ('pending', 'reminded', 'met', 'missed', 'cancelled');

-- CreateEnum
CREATE TYPE "CareerInterviewMode" AS ENUM ('onsite', 'video', 'phone', 'written');

-- CreateEnum
CREATE TYPE "CareerInterviewState" AS ENUM ('scheduled', 'completed', 'cancelled', 'no_show');

-- CreateEnum
CREATE TYPE "CareerOutcomeResult" AS ENUM ('offer', 'rejection', 'no_response', 'withdrawn', 'expired');

-- CreateEnum
CREATE TYPE "CareerFollowUpChannel" AS ENUM ('email_draft', 'letter_draft', 'manual_note');

-- CreateEnum
CREATE TYPE "CareerFollowUpState" AS ENUM ('planned', 'drafted', 'done', 'cancelled');

-- CreateEnum
CREATE TYPE "CareerSubmissionState" AS ENUM ('pending', 'succeeded', 'failed', 'refused');

-- CreateEnum
CREATE TYPE "CareerConfirmationState" AS ENUM ('pending', 'approved', 'rejected', 'expired', 'consumed');

-- CreateEnum
CREATE TYPE "CareerConfirmationPurpose" AS ENUM ('submit_application');

-- CreateTable
CREATE TABLE "career_profiles" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "headline" VARCHAR(160) NOT NULL,
    "summary" VARCHAR(2000) NOT NULL,
    "yearsExperience" INTEGER NOT NULL,
    "highestDegree" VARCHAR(16) NOT NULL,
    "skills" TEXT[],
    "languages" JSONB NOT NULL,
    "publications" INTEGER NOT NULL DEFAULT 0,
    "preferences" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "career_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_opportunities" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "CareerOpportunityKind" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "organization" VARCHAR(160) NOT NULL,
    "location" VARCHAR(120) NOT NULL,
    "remote" BOOLEAN NOT NULL DEFAULT false,
    "description" VARCHAR(8200) NOT NULL,
    "requirements" TEXT[],
    "compensation" JSONB,
    "postedAt" TIMESTAMPTZ(3),
    "closesAt" TIMESTAMPTZ(3),
    "externalRef" VARCHAR(128),
    "canonicalUrl" VARCHAR(2048),
    "fingerprint" CHAR(64) NOT NULL,
    "provenance" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "career_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_applications" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "opportunityId" UUID NOT NULL,
    "state" "CareerApplicationState" NOT NULL DEFAULT 'discovered',
    "stateChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "matchScore" INTEGER,
    "notes" VARCHAR(2000) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "career_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_document_variants" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "kind" "CareerDocumentKind" NOT NULL,
    "revision" INTEGER NOT NULL,
    "parentVariantId" UUID,
    "profileVersion" INTEGER NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "body" VARCHAR(40200) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "career_document_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_contacts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "applicationId" UUID,
    "opportunityId" UUID,
    "displayName" VARCHAR(120) NOT NULL,
    "role" VARCHAR(120) NOT NULL,
    "organization" VARCHAR(160) NOT NULL,
    "email" VARCHAR(254),
    "notes" VARCHAR(2000) NOT NULL,
    "source" "CareerSourceKind" NOT NULL DEFAULT 'manual_entry',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "career_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_deadlines" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "kind" "CareerDeadlineKind" NOT NULL,
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "state" "CareerDeadlineState" NOT NULL DEFAULT 'pending',
    "label" VARCHAR(200) NOT NULL,
    "reminderOffsetsMinutes" INTEGER[],
    "remindedOffsetsMinutes" INTEGER[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "career_deadlines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_interviews" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "mode" "CareerInterviewMode" NOT NULL,
    "stage" VARCHAR(120) NOT NULL,
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 60,
    "state" "CareerInterviewState" NOT NULL DEFAULT 'scheduled',
    "notes" VARCHAR(2000) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "career_interviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_outcomes" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "result" "CareerOutcomeResult" NOT NULL,
    "decidedAt" TIMESTAMPTZ(3) NOT NULL,
    "notes" VARCHAR(2000) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "career_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_follow_ups" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "channel" "CareerFollowUpChannel" NOT NULL,
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "state" "CareerFollowUpState" NOT NULL DEFAULT 'planned',
    "draft" VARCHAR(2200) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "career_follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_submission_attempts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "idempotencyKey" CHAR(64) NOT NULL,
    "confirmationId" UUID NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "adapter" VARCHAR(64) NOT NULL,
    "state" "CareerSubmissionState" NOT NULL DEFAULT 'pending',
    "receipt" VARCHAR(200),
    "failureReason" VARCHAR(400),
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "career_submission_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_confirmations" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "purpose" "CareerConfirmationPurpose" NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "state" "CareerConfirmationState" NOT NULL DEFAULT 'pending',
    "summary" VARCHAR(400) NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "decidedAt" TIMESTAMPTZ(3),
    "consumedAt" TIMESTAMPTZ(3),

    CONSTRAINT "career_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_application_events" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "fromState" "CareerApplicationState",
    "toState" "CareerApplicationState",
    "summary" VARCHAR(400) NOT NULL,
    "context" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "career_application_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "career_profiles_userId_key" ON "career_profiles"("userId");

-- CreateIndex
CREATE INDEX "career_opportunities_userId_closesAt_idx" ON "career_opportunities"("userId", "closesAt");

-- CreateIndex
CREATE INDEX "career_opportunities_userId_kind_createdAt_idx" ON "career_opportunities"("userId", "kind", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "career_opportunities_userId_fingerprint_key" ON "career_opportunities"("userId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "career_opportunities_userId_canonicalUrl_key" ON "career_opportunities"("userId", "canonicalUrl");

-- CreateIndex
CREATE INDEX "career_applications_userId_state_updatedAt_idx" ON "career_applications"("userId", "state", "updatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "career_applications_userId_opportunityId_key" ON "career_applications"("userId", "opportunityId");

-- CreateIndex
CREATE INDEX "career_document_variants_userId_applicationId_idx" ON "career_document_variants"("userId", "applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "career_document_variants_applicationId_kind_revision_key" ON "career_document_variants"("applicationId", "kind", "revision");

-- CreateIndex
CREATE INDEX "career_contacts_userId_createdAt_idx" ON "career_contacts"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "career_contacts_userId_applicationId_idx" ON "career_contacts"("userId", "applicationId");

-- CreateIndex
CREATE INDEX "career_deadlines_userId_state_dueAt_idx" ON "career_deadlines"("userId", "state", "dueAt");

-- CreateIndex
CREATE INDEX "career_deadlines_applicationId_idx" ON "career_deadlines"("applicationId");

-- CreateIndex
CREATE INDEX "career_interviews_userId_scheduledAt_idx" ON "career_interviews"("userId", "scheduledAt");

-- CreateIndex
CREATE INDEX "career_interviews_applicationId_idx" ON "career_interviews"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "career_outcomes_applicationId_key" ON "career_outcomes"("applicationId");

-- CreateIndex
CREATE INDEX "career_outcomes_userId_decidedAt_idx" ON "career_outcomes"("userId", "decidedAt" DESC);

-- CreateIndex
CREATE INDEX "career_follow_ups_userId_state_dueAt_idx" ON "career_follow_ups"("userId", "state", "dueAt");

-- CreateIndex
CREATE INDEX "career_follow_ups_applicationId_idx" ON "career_follow_ups"("applicationId");

-- CreateIndex
CREATE INDEX "career_submission_attempts_applicationId_startedAt_idx" ON "career_submission_attempts"("applicationId", "startedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "career_submission_attempts_userId_idempotencyKey_key" ON "career_submission_attempts"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "career_confirmations_userId_state_expiresAt_idx" ON "career_confirmations"("userId", "state", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "career_confirmations_userId_applicationId_purpose_payloadHa_key" ON "career_confirmations"("userId", "applicationId", "purpose", "payloadHash");

-- CreateIndex
CREATE INDEX "career_application_events_userId_createdAt_idx" ON "career_application_events"("userId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "career_application_events_applicationId_sequence_key" ON "career_application_events"("applicationId", "sequence");

-- AddForeignKey
ALTER TABLE "career_profiles" ADD CONSTRAINT "career_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_opportunities" ADD CONSTRAINT "career_opportunities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_applications" ADD CONSTRAINT "career_applications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_applications" ADD CONSTRAINT "career_applications_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "career_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_document_variants" ADD CONSTRAINT "career_document_variants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_document_variants" ADD CONSTRAINT "career_document_variants_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "career_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_document_variants" ADD CONSTRAINT "career_document_variants_parentVariantId_fkey" FOREIGN KEY ("parentVariantId") REFERENCES "career_document_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_contacts" ADD CONSTRAINT "career_contacts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_contacts" ADD CONSTRAINT "career_contacts_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "career_applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_contacts" ADD CONSTRAINT "career_contacts_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "career_opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_deadlines" ADD CONSTRAINT "career_deadlines_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_deadlines" ADD CONSTRAINT "career_deadlines_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "career_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_interviews" ADD CONSTRAINT "career_interviews_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_interviews" ADD CONSTRAINT "career_interviews_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "career_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_outcomes" ADD CONSTRAINT "career_outcomes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_outcomes" ADD CONSTRAINT "career_outcomes_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "career_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_follow_ups" ADD CONSTRAINT "career_follow_ups_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_follow_ups" ADD CONSTRAINT "career_follow_ups_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "career_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_submission_attempts" ADD CONSTRAINT "career_submission_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_submission_attempts" ADD CONSTRAINT "career_submission_attempts_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "career_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_submission_attempts" ADD CONSTRAINT "career_submission_attempts_confirmationId_fkey" FOREIGN KEY ("confirmationId") REFERENCES "career_confirmations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_confirmations" ADD CONSTRAINT "career_confirmations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_confirmations" ADD CONSTRAINT "career_confirmations_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "career_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_application_events" ADD CONSTRAINT "career_application_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_application_events" ADD CONSTRAINT "career_application_events_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "career_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Invariants Prisma cannot express
--
-- Each of these is a rule the service also enforces. They are repeated here
-- because the service is a process and a process can be killed between two
-- statements, while a constraint cannot.
-- ─────────────────────────────────────────────────────────────────────────────

-- A decision always has a timestamp, and an undecided request never does.
-- Consumption is strictly stronger: only a consumed approval has `consumedAt`,
-- which is what makes "this approval was already spent" a fact rather than a
-- flag someone has to remember to set.
ALTER TABLE "career_confirmations"
ADD CONSTRAINT "career_confirmations_decision_consistency" CHECK (
  (("state" = 'pending') = ("decidedAt" IS NULL))
  AND (("state" = 'consumed') = ("consumedAt" IS NOT NULL))
);

-- Expiry is in the future when the question is asked.
ALTER TABLE "career_confirmations"
ADD CONSTRAINT "career_confirmations_expiry_after_request" CHECK ("expiresAt" > "requestedAt");

-- At most one pending approval per application and purpose. Without this, two
-- payload revisions could each hold a live question, and answering the older
-- one would authorise a payload the owner has already moved past.
CREATE UNIQUE INDEX "career_confirmations_one_pending_per_purpose"
ON "career_confirmations"("userId", "applicationId", "purpose")
WHERE "state" = 'pending';

-- A pending attempt has neither an end nor a receipt; a successful one has
-- both; a failed or refused one has ended and carries no receipt.
ALTER TABLE "career_submission_attempts"
ADD CONSTRAINT "career_submission_attempts_state_consistency" CHECK (
  ("state" = 'pending' AND "finishedAt" IS NULL AND "receipt" IS NULL)
  OR ("state" = 'succeeded' AND "finishedAt" IS NOT NULL AND "receipt" IS NOT NULL)
  OR ("state" IN ('failed', 'refused') AND "finishedAt" IS NOT NULL AND "receipt" IS NULL)
);

-- Hashes are lowercase hex of the stated width. A column typed CHAR(64) would
-- otherwise accept 64 spaces, and a fingerprint of spaces deduplicates
-- everything against everything.
ALTER TABLE "career_opportunities"
ADD CONSTRAINT "career_opportunities_fingerprint_hex" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$');

ALTER TABLE "career_document_variants"
ADD CONSTRAINT "career_document_variants_content_hash_hex" CHECK ("contentHash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "career_confirmations"
ADD CONSTRAINT "career_confirmations_payload_hash_hex" CHECK ("payloadHash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "career_submission_attempts"
ADD CONSTRAINT "career_submission_attempts_hashes_hex" CHECK (
  "idempotencyKey" ~ '^[0-9a-f]{64}$' AND "payloadHash" ~ '^[0-9a-f]{64}$'
);

-- A frozen match score is a percentage or it is absent.
ALTER TABLE "career_applications"
ADD CONSTRAINT "career_applications_match_score_range" CHECK (
  "matchScore" IS NULL OR ("matchScore" >= 0 AND "matchScore" <= 100)
);

-- Lineage and history are one-based and dense enough that a gap is visible.
ALTER TABLE "career_document_variants"
ADD CONSTRAINT "career_document_variants_revision_positive" CHECK ("revision" >= 1);

ALTER TABLE "career_application_events"
ADD CONSTRAINT "career_application_events_sequence_positive" CHECK ("sequence" >= 1);

-- A variant cannot be its own parent.
ALTER TABLE "career_document_variants"
ADD CONSTRAINT "career_document_variants_parent_not_self" CHECK ("parentVariantId" <> "id");
