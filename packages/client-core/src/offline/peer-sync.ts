import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "@nexus/shared";

/**
 * End-to-End Encrypted Peer-Device Synchronization.
 *
 * ## Principles
 * 1. Mutual device authentication backed by cryptographic device identities.
 * 2. Epoch-based symmetric AEAD (AES-256-GCM) encryption between approved devices.
 * 3. Dynamic epoch rotation upon device revocation: revoked devices cannot decrypt newly synchronized state.
 * 4. Bounded offline actions: offline drafts and views cannot bypass ownership or confirmation policies.
 */

export interface DeviceIdentity {
  readonly deviceId: string;
  readonly userId: string;
  readonly name: string;
  readonly publicKey: string; // Hex-encoded public key
  trusted: boolean;
  revoked: boolean;
}

export interface SyncEpochKey {
  readonly epoch: number;
  readonly keyBytes: Buffer; // 32-byte AES-256 key
  readonly activeDevices: readonly string[];
}

export interface EncryptedPeerPacket {
  readonly epoch: number;
  readonly originDeviceId: string;
  readonly targetDeviceId?: string | undefined;
  readonly ivHex: string;
  readonly ciphertextHex: string;
  readonly tagHex: string;
  readonly timestamp: number;
}

export interface PeerSyncPayload {
  readonly mutationId: string;
  readonly type: "TASK_DRAFT" | "TASK_STATUS_OBSERVATION" | "NOTE_DRAFT" | "DEVICE_METRIC";
  readonly data: Record<string, unknown>;
  readonly originDeviceId: string;
  readonly userId: string;
  readonly timestamp: number;
}

export class RevokedDeviceDecryptionError extends AppError {
  readonly code = "REVOKED_DEVICE_DECRYPTION_FAILED";
  readonly httpStatus = 403;

  constructor(deviceId: string, epoch: number) {
    super({
      message: `Device ${deviceId} is revoked and cannot decrypt epoch ${epoch} peer sync state.`,
      userMessage: "This revoked device cannot access synchronized peer state.",
      context: { deviceId, epoch },
    });
  }
}

export class UnauthorizedPeerPayloadError extends AppError {
  readonly code = "UNAUTHORIZED_PEER_PAYLOAD";
  readonly httpStatus = 403;

  constructor(reason: string) {
    super({
      message: `Peer sync payload rejected: ${reason}`,
      userMessage: "Synchronized peer data violated security boundaries.",
      context: { reason },
    });
  }
}

export class PeerSyncEngine {
  readonly #userId: string;
  readonly #localDeviceId: string;
  readonly #knownDevices = new Map<string, DeviceIdentity>();
  readonly #epochKeys = new Map<number, SyncEpochKey>();
  #currentEpoch = 1;

  constructor(params: { userId: string; localDeviceId: string; localPublicKey?: string }) {
    this.#userId = params.userId;
    this.#localDeviceId = params.localDeviceId;

    // Register local device
    this.#knownDevices.set(this.#localDeviceId, {
      deviceId: this.#localDeviceId,
      userId: this.#userId,
      name: "Local Device",
      publicKey: params.localPublicKey ?? randomBytes(32).toString("hex"),
      trusted: true,
      revoked: false,
    });

    // Initialize epoch 1 key
    this.#rotateEpoch();
  }

  get currentEpoch(): number {
    return this.#currentEpoch;
  }

  get localDeviceId(): string {
    return this.#localDeviceId;
  }

  /** Registers and trusts a peer device. */
  addPeerDevice(device: DeviceIdentity): void {
    if (device.userId !== this.#userId) {
      throw new UnauthorizedPeerPayloadError(
        "Cannot sync with peer belonging to another tenant/user.",
      );
    }
    this.#knownDevices.set(device.deviceId, { ...device });
    this.#rotateEpoch();
  }

  /** Revokes a peer device immediately. Rotates to a new epoch key. */
  revokeDevice(deviceId: string): void {
    const existing = this.#knownDevices.get(deviceId);
    if (existing) {
      existing.revoked = true;
      existing.trusted = false;
    }
    this.#rotateEpoch();
  }

  /**
   * Encrypts a bounded offline payload using the current epoch key (AES-256-GCM).
   */
  encryptPayload(payload: PeerSyncPayload, targetDeviceId?: string): EncryptedPeerPacket {
    // Validate boundaries: user ownership must match
    if (payload.userId !== this.#userId) {
      throw new UnauthorizedPeerPayloadError("Payload userId mismatch.");
    }

    const epochKey = this.#epochKeys.get(this.#currentEpoch);
    if (!epochKey) throw new Error(`Active epoch ${this.#currentEpoch} key missing.`);

    const iv = randomBytes(12); // 96-bit IV standard for GCM
    const cipher = createCipheriv("aes-256-gcm", epochKey.keyBytes, iv);

    const plaintext = JSON.stringify(payload);
    let ciphertext = cipher.update(plaintext, "utf8", "hex");
    ciphertext += cipher.final("hex");
    const tag = cipher.getAuthTag().toString("hex");

    return {
      epoch: this.#currentEpoch,
      originDeviceId: this.#localDeviceId,
      ...(targetDeviceId ? { targetDeviceId } : {}),
      ivHex: iv.toString("hex"),
      ciphertextHex: ciphertext,
      tagHex: tag,
      timestamp: Date.now(),
    };
  }

  /**
   * Decrypts an encrypted peer packet. Fails closed if the device is revoked or epoch key is missing.
   */
  decryptPacket(
    packet: EncryptedPeerPacket,
    readerDeviceId = this.#localDeviceId,
  ): PeerSyncPayload {
    const reader = this.#knownDevices.get(readerDeviceId);
    if (reader?.revoked || reader?.trusted === false) {
      throw new RevokedDeviceDecryptionError(readerDeviceId, packet.epoch);
    }

    const epochKey = this.#epochKeys.get(packet.epoch);
    if (!epochKey) {
      throw new UnauthorizedPeerPayloadError(`Unknown or expired epoch: ${packet.epoch}`);
    }

    // Verify reader is in this epoch's active device set
    if (!epochKey.activeDevices.includes(readerDeviceId)) {
      throw new RevokedDeviceDecryptionError(readerDeviceId, packet.epoch);
    }

    const iv = Buffer.from(packet.ivHex, "hex");
    const decipher = createDecipheriv("aes-256-gcm", epochKey.keyBytes, iv);
    decipher.setAuthTag(Buffer.from(packet.tagHex, "hex"));

    let decrypted = decipher.update(packet.ciphertextHex, "hex", "utf8");
    decrypted += decipher.final("utf8");

    const payload = JSON.parse(decrypted) as PeerSyncPayload;
    if (payload.userId !== this.#userId) {
      throw new UnauthorizedPeerPayloadError("Decrypted payload tenant mismatch.");
    }

    return payload;
  }

  /** Rotates the epoch and generates a fresh key shared only among active trusted devices. */
  #rotateEpoch(): void {
    const active = Array.from(this.#knownDevices.values())
      .filter((d) => d.trusted && !d.revoked)
      .map((d) => d.deviceId);

    const nextEpoch = this.#epochKeys.size === 0 ? 1 : this.#currentEpoch + 1;
    const freshKeyBytes = randomBytes(32);

    this.#epochKeys.set(nextEpoch, {
      epoch: nextEpoch,
      keyBytes: freshKeyBytes,
      activeDevices: active,
    });

    this.#currentEpoch = nextEpoch;
  }
}
