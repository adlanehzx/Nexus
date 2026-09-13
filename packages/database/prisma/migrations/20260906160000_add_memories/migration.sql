-- CreateEnum
CREATE TYPE "MemoryLayer" AS ENUM ('LONG_TERM', 'PREFERENCE');

-- CreateEnum
CREATE TYPE "MemoryKind" AS ENUM ('SEMANTIC', 'EPISODIC', 'PROCEDURAL');

-- CreateEnum
CREATE TYPE "MemoryOrigin" AS ENUM ('USER', 'AGENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MemorySensitivity" AS ENUM ('ORDINARY', 'PERSONAL');

-- CreateTable
CREATE TABLE "memories" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "layer" "MemoryLayer" NOT NULL DEFAULT 'LONG_TERM',
    "kind" "MemoryKind" NOT NULL,
    "content" TEXT NOT NULL,
    "importance" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "origin" "MemoryOrigin" NOT NULL DEFAULT 'USER',
    "sensitivity" "MemorySensitivity" NOT NULL DEFAULT 'ORDINARY',
    "sensitiveCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "validFrom" TIMESTAMPTZ(3) NOT NULL,
    "validUntil" TIMESTAMPTZ(3),
    "supersededById" UUID,
    "supersedesId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memories_userId_layer_validUntil_idx" ON "memories"("userId", "layer", "validUntil");
CREATE INDEX "memories_userId_kind_validUntil_idx" ON "memories"("userId", "kind", "validUntil");
CREATE INDEX "memories_userId_validFrom_idx" ON "memories"("userId", "validFrom" DESC);

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memories" ADD CONSTRAINT "memories_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "memories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "memories" ADD CONSTRAINT "memories_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "memories"("id") ON DELETE SET NULL ON UPDATE CASCADE;