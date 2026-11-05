-- CreateTable
CREATE TABLE "mcp_access_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "scopes" TEXT[],
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "lastUsedAt" TIMESTAMPTZ(3),

    CONSTRAINT "mcp_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_activity" (
    "id" UUID NOT NULL,
    "tokenId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tool" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "errorCode" TEXT,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mcp_activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_access_tokens_tokenHash_key" ON "mcp_access_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "mcp_access_tokens_userId_createdAt_idx" ON "mcp_access_tokens"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "mcp_activity_userId_createdAt_idx" ON "mcp_activity"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "mcp_access_tokens" ADD CONSTRAINT "mcp_access_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_activity" ADD CONSTRAINT "mcp_activity_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "mcp_access_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

