-- Catches up schema drift in migration history.
--
-- `DeviceCredentialKind.ECDSA_P256_PUBLIC_KEY` was declared in
-- `schema.prisma` without any migration creating it. The value was missing
-- in databases, causing an enum error when registering Android device keys
-- whose hardware keystore cannot hold Ed25519 keys.
--
-- `IF NOT EXISTS` makes the migration replayable if manually added.
ALTER TYPE "DeviceCredentialKind" ADD VALUE IF NOT EXISTS 'ECDSA_P256_PUBLIC_KEY';
