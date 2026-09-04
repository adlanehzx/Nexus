/*
  Warnings:

  - You are about to drop the column `capabilities` on the `devices` table. All the data in the column will be lost.
  - You are about to drop the column `publicKey` on the `devices` table. All the data in the column will be lost.
  - Added the required column `role` to the `devices` table without a default value. This is not possible if the table is not empty.
  - Added the required column `type` to the `devices` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('IPHONE', 'ANDROID', 'WINDOWS_PC', 'MAC', 'LINUX', 'BROWSER_WORKER');

-- CreateEnum
CREATE TYPE "DeviceRole" AS ENUM ('CLIENT', 'WORKER', 'BOTH');

-- CreateEnum
CREATE TYPE "TrustState" AS ENUM ('PENDING', 'TRUSTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "DeviceCredentialKind" AS ENUM ('ED25519_PUBLIC_KEY', 'SERVICE_TOKEN_HASH');

-- CreateEnum
CREATE TYPE "TaskPlanStatus" AS ENUM ('PENDING', 'RUNNING', 'WAITING_FOR_CONFIRMATION', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "TaskStepStatus" AS ENUM ('PENDING', 'READY', 'ASSIGNED', 'RUNNING', 'WAITING_FOR_CONFIRMATION', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "DeviceStatus" ADD VALUE 'DEGRADED';

-- DropIndex
DROP INDEX "devices_publicKey_key";

-- DropIndex
DROP INDEX "devices_userId_status_idx";

-- AlterTable
ALTER TABLE "devices" DROP COLUMN "capabilities",
DROP COLUMN "publicKey",
ADD COLUMN     "grantedPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "health" JSONB NOT NULL DEFAULT '{"activeTasks":0,"maxConcurrentTasks":1}',
ADD COLUMN     "metadata" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "role" "DeviceRole" NOT NULL,
ADD COLUMN     "trust" "TrustState" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "type" "DeviceType" NOT NULL;

-- CreateTable
CREATE TABLE "device_capabilities" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1',
    "description" TEXT NOT NULL DEFAULT '',
    "inputSchema" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "declaredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_credentials" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "kind" "DeviceCredentialKind" NOT NULL,
    "material" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "device_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_sessions" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "lastHeartbeatAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedFromId" UUID,
    "revokedAt" TIMESTAMPTZ(3),
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "remoteAddress" TEXT,

    CONSTRAINT "device_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_plans" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "originClientDeviceId" UUID NOT NULL,
    "runId" UUID,
    "conversationId" UUID,
    "correlationId" TEXT NOT NULL,
    "status" "TaskPlanStatus" NOT NULL DEFAULT 'PENDING',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "task_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_steps" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "requiredCapabilities" TEXT[],
    "tool" TEXT NOT NULL,
    "arguments" JSONB NOT NULL DEFAULT '{}',
    "dependsOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "selectedDeviceId" UUID,
    "preferredDeviceId" UUID,
    "constraints" JSONB,
    "riskLevel" TEXT NOT NULL DEFAULT 'MEDIUM',
    "retryPolicy" JSONB NOT NULL DEFAULT '{"attempts":1,"backoffMs":1000,"failoverToAnotherDevice":false}',
    "timeoutMs" INTEGER NOT NULL DEFAULT 300000,
    "status" "TaskStepStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "error" JSONB,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "task_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_executions" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "stepId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "TaskStepStatus" NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "durationMs" INTEGER,
    "input" JSONB,
    "result" JSONB,
    "error" JSONB,

    CONSTRAINT "task_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_capabilities_name_enabled_idx" ON "device_capabilities"("name", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "device_capabilities_deviceId_name_key" ON "device_capabilities"("deviceId", "name");

-- CreateIndex
CREATE INDEX "device_credentials_deviceId_revokedAt_idx" ON "device_credentials"("deviceId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "device_sessions_tokenHash_key" ON "device_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "device_sessions_deviceId_revokedAt_idx" ON "device_sessions"("deviceId", "revokedAt");

-- CreateIndex
CREATE INDEX "device_sessions_expiresAt_idx" ON "device_sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "task_plans_userId_status_createdAt_idx" ON "task_plans"("userId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "task_plans_originClientDeviceId_idx" ON "task_plans"("originClientDeviceId");

-- CreateIndex
CREATE INDEX "task_steps_taskId_status_idx" ON "task_steps"("taskId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "task_steps_taskId_key_key" ON "task_steps"("taskId", "key");

-- CreateIndex
CREATE INDEX "task_executions_taskId_startedAt_idx" ON "task_executions"("taskId", "startedAt");

-- CreateIndex
CREATE INDEX "task_executions_deviceId_startedAt_idx" ON "task_executions"("deviceId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "devices_userId_role_status_idx" ON "devices"("userId", "role", "status");

-- CreateIndex
CREATE INDEX "devices_userId_trust_idx" ON "devices"("userId", "trust");

-- AddForeignKey
ALTER TABLE "device_capabilities" ADD CONSTRAINT "device_capabilities_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_plans" ADD CONSTRAINT "task_plans_originClientDeviceId_fkey" FOREIGN KEY ("originClientDeviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_steps" ADD CONSTRAINT "task_steps_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "task_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_executions" ADD CONSTRAINT "task_executions_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "task_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_executions" ADD CONSTRAINT "task_executions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
