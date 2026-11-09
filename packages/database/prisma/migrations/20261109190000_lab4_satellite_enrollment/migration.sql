-- Lab 4 — network enrolment of ESP32 satellites and per-owner ADB TVs.
-- Replaces hand-written SATELLITE_TOKEN_HASHES_JSON / FIRE_TV_ADB_SERIAL setups.

CREATE TABLE "home_satellites" (
    "deviceId" TEXT NOT NULL,
    "ownerId" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "enrollSecretHash" TEXT NOT NULL,
    "verificationCode" TEXT NOT NULL,
    "tokenHash" TEXT,
    "tokenDelivered" BOOLEAN NOT NULL DEFAULT false,
    "firmware" TEXT,
    "capabilities" JSONB NOT NULL,
    "roomId" UUID,
    "sourceIp" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "approvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "home_satellites_pkey" PRIMARY KEY ("deviceId")
);

CREATE TABLE "home_adb_devices" (
    "ownerId" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "home_adb_devices_pkey" PRIMARY KEY ("ownerId","serial")
);

CREATE INDEX "home_satellites_ownerId_idx" ON "home_satellites"("ownerId");

CREATE INDEX "home_satellites_status_idx" ON "home_satellites"("status");

