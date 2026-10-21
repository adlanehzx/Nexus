-- Single-use device pairing tickets.
--
-- Strictly additive migration: a new table, no touched columns,
-- no rewritten data. It can be applied on live instances without downtime,
-- and rollback is simply a DROP TABLE.
--
-- `code_hash` is unique: code uniqueness is a security property enforced
-- at the database level rather than caller discipline.
CREATE TABLE "device_pairing_tickets" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "deviceId" UUID,
    "label" VARCHAR(120),

    CONSTRAINT "device_pairing_tickets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "device_pairing_tickets_codeHash_key" ON "device_pairing_tickets"("codeHash");
CREATE INDEX "device_pairing_tickets_userId_createdAt_idx" ON "device_pairing_tickets"("userId", "createdAt");
CREATE INDEX "device_pairing_tickets_expiresAt_idx" ON "device_pairing_tickets"("expiresAt");
