CREATE TABLE "OsintCaseSnapshot" (
  "id" UUID NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL,
  "payload" JSONB NOT NULL, "updatedAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "OsintCaseSnapshot_ownerId_idx" ON "OsintCaseSnapshot"("ownerId");
CREATE TABLE "OsintMissionSnapshot" (
  "id" UUID NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "caseId" UUID NOT NULL,
  "status" TEXT NOT NULL, "payload" JSONB NOT NULL, "updatedAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "OsintMissionSnapshot_ownerId_status_idx" ON "OsintMissionSnapshot"("ownerId", "status");
CREATE TABLE "OsintImport" (
  "id" TEXT NOT NULL PRIMARY KEY, "importedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
