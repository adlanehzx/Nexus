import { createPublicKey } from "node:crypto";
import type { PrismaClient } from "@nexus/database";
import { uuidv7 } from "@nexus/shared";
import type { DeviceCredentialStore } from "@nexus/devices";

/**
 * Device public keys on PostgreSQL.
 *
 * ## Why this store exists
 *
 * The `device_credentials` table was in the schema from the beginning, but
 * nothing wrote to it: production was mounting `InMemoryCredentialProvider`.
 * The consequence was not a lack of features but a **silent failure**:
 * whenever the API restarted, all keys disappeared. A
 * worker would reconnect, sign its challenge, and be rejected because
 * there was nothing left to verify its signature. Nothing reported the
 * root cause, and the only remedy was to re-register every device.
 *
 * This is exactly the failure class described in the preamble of
 * `persistence.pg.test.ts`: what is only tested against a mock is not
 * verified.
 *
 * ## Revoking is not deleting
 *
 * A revocation writes `revokedAt` instead of deleting the row. The public key
 * is not a secret — it is the shareable half — and preserving the audit trail
 * answers questions asked after an incident: *which* key was
 * registered, and since when. Reads ignore revoked rows, so the
 * effect is identical for authentication.
 */
export class PrismaDeviceCredentialStore implements DeviceCredentialStore {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async publicKeyFor(deviceId: string): Promise<string | undefined> {
    const row = await this.#prisma.deviceCredential.findFirst({
      where: {
        deviceId,
        revokedAt: null,
        kind: { in: ["ED25519_PUBLIC_KEY", "ECDSA_P256_PUBLIC_KEY"] },
        // An expired key no longer verifies anything. `null` means "no
        // expiration", which is the common case for a hardware key.
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      // The most recent wins: this makes key rotation effective without
      // requiring the old key to be removed first.
      orderBy: { createdAt: "desc" },
    });
    return row === null ? undefined : row.material;
  }

  /**
   * Registers a key, replacing the one previously used.
   *
   * Replacement is a **rotation**: the old row receives `rotatedAt`
   * and `revokedAt` rather than being deleted. Two active keys for the same
   * device would introduce ambiguity — which one should verify? — and the query
   * above would decide by date, which is too implicit
   * for an authentication decision.
   */
  async set(deviceId: string, publicKeyPem: string): Promise<void> {
    const kind = credentialKind(publicKeyPem);
    const now = new Date();
    await this.#prisma.$transaction(async (tx) => {
      await tx.deviceCredential.updateMany({
        where: { deviceId, revokedAt: null },
        data: { rotatedAt: now, revokedAt: now },
      });
      await tx.deviceCredential.create({
        data: { id: uuidv7(), deviceId, kind, material: publicKeyPem, createdAt: now },
      });
    });
  }

  async revoke(deviceId: string): Promise<void> {
    const now = new Date();
    await this.#prisma.deviceCredential.updateMany({
      where: { deviceId, revokedAt: null },
      data: { revokedAt: now },
    });
  }
}

/**
 * Determines the algorithm **from the key itself**, rather than from what is claimed.
 *
 * Android cannot store an Ed25519 key in its hardware keystore and
 * therefore provides ECDSA P-256; a desktop workstation provides Ed25519. Letting
 * the caller declare its algorithm would introduce a discrepancy between the label
 * and the content, with the label dictating the verifier.
 */
function credentialKind(publicKeyPem: string): "ED25519_PUBLIC_KEY" | "ECDSA_P256_PUBLIC_KEY" {
  let type: string;
  try {
    type = createPublicKey(publicKeyPem).asymmetricKeyType ?? "";
  } catch (error) {
    throw new Error("unreadable public key: not a valid PEM", { cause: error });
  }
  if (type === "ed25519") return "ED25519_PUBLIC_KEY";
  if (type === "ec") return "ECDSA_P256_PUBLIC_KEY";
  throw new Error(`unsupported key algorithm: ${type}`);
}
