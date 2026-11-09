-- Lab 4 — Domotique: Home Assistant link, rooms, device settings, scenes,
-- routines and their execution log. The HA token is stored in the secret
-- vault; only its reference lives here.

CREATE TABLE "home_assistant_links" (
    "id" UUID NOT NULL,
    "ownerId" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "tokenRef" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sensitiveClasses" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "home_assistant_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "home_assistant_links_ownerId_key" ON "home_assistant_links"("ownerId");

CREATE TABLE "home_rooms" (
    "id" UUID NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "haAreaId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "home_rooms_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "home_rooms_ownerId_haAreaId_key" ON "home_rooms"("ownerId", "haAreaId");
CREATE INDEX "home_rooms_ownerId_idx" ON "home_rooms"("ownerId");

CREATE TABLE "home_device_settings" (
    "ownerId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "roomId" UUID,
    "sensitive" BOOLEAN,
    "alias" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "home_device_settings_pkey" PRIMARY KEY ("ownerId", "deviceId")
);

CREATE TABLE "home_scenes" (
    "id" UUID NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "actions" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "home_scenes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "home_scenes_ownerId_idx" ON "home_scenes"("ownerId");

CREATE TABLE "home_routines" (
    "id" UUID NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "trigger" JSONB NOT NULL,
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "lastRunAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "home_routines_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "home_routines_ownerId_idx" ON "home_routines"("ownerId");

CREATE TABLE "home_execution_logs" (
    "id" UUID NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "home_execution_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "home_execution_logs_ownerId_createdAt_idx" ON "home_execution_logs"("ownerId", "createdAt" DESC);
