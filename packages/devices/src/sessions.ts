import { createHash, randomBytes, timingSafeEqual, verify as verifySignature } from "node:crypto";
import { uuidv7 } from "@nexus/shared";
import { DeviceAuthenticationError, ReplayRejectedError } from "./errors.js";
import type { DeviceRegistry } from "./registry.js";
import { isSessionActive, type DeviceCredential, type DeviceSession } from "./types.js";

/**
 * Authenticated device sessions.
 *
 * Device IDs are public identifiers that do not authenticate.
 * Authentication relies on signing a challenge nonce with a private key
 * that never leaves the device, yielding a time-limited session token.
 *
 * Transports (WebSocket, HTTP) connect to this service through clean ports,
 * enabling comprehensive testing without establishing live network sockets.
 */

export interface Challenge {
  deviceId: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface AuthenticateInput {
  deviceId: string;
  nonce: string;
  /** Signature of the challenge nonce by device private key, base64-encoded. */
  signature: string;
  capabilities?: readonly string[];
  remoteAddress?: string;
}

export interface IssuedSession {
  session: DeviceSession;
  /** Single-use bearer token returned once upon issuance. Only its SHA-256 hash is persisted. */
  token: string;
}

/** Signature verification function. Pluggable to decouple unit tests from crypto. */
export type SignatureVerifier = (
  publicKeyMaterial: string,
  nonce: string,
  signature: string,
) => boolean;

/**
 * Default Ed25519 signature verifier.
 *
 * Expects SPKI PEM public key. Malformed keys or unparseable signatures fail safely.
 */
export const ed25519Verifier: SignatureVerifier = (publicKeyMaterial, nonce, signature) => {
  try {
    return verifySignature(
      null,
      Buffer.from(nonce, "utf8"),
      publicKeyMaterial,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
};

/**
 * ECDSA P-256 signature verifier with SHA-256.
 *
 * Android Keystore historically lacked support for Ed25519. Android devices
 * requiring hardware-backed, non-extractable keys in Secure Enclave / TEE use
 * NIST P-256 curves.
 *
 * Signature format expects DER encoding as emitted by Android's
 * `Signature.getInstance("SHA256withECDSA")`.
 */
export const ecdsaP256Verifier: SignatureVerifier = (publicKeyMaterial, nonce, signature) => {
  try {
    return verifySignature(
      "sha256",
      Buffer.from(nonce, "utf8"),
      publicKeyMaterial,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
};

/** Resolves verifier matching registered device credential type. */
export function verifierForCredential(kind: DeviceCredential["kind"]): SignatureVerifier {
  return kind === "ECDSA_P256_PUBLIC_KEY" ? ecdsaP256Verifier : ed25519Verifier;
}

export interface DeviceSessionStore {
  save(session: DeviceSession): Promise<void>;
  get(id: string): Promise<DeviceSession | undefined>;
  findByTokenHash(tokenHash: string): Promise<DeviceSession | undefined>;
  listByDevice(deviceId: string): Promise<DeviceSession[]>;
}

export class InMemoryDeviceSessionStore implements DeviceSessionStore {
  readonly #byId = new Map<string, DeviceSession>();

  save(session: DeviceSession): Promise<void> {
    this.#byId.set(session.id, structuredClone(session));
    return Promise.resolve();
  }

  get(id: string): Promise<DeviceSession | undefined> {
    const session = this.#byId.get(id);
    return Promise.resolve(session === undefined ? undefined : structuredClone(session));
  }

  findByTokenHash(tokenHash: string): Promise<DeviceSession | undefined> {
    for (const session of this.#byId.values()) {
      if (session.tokenHash === tokenHash) return Promise.resolve(structuredClone(session));
    }
    return Promise.resolve(undefined);
  }

  listByDevice(deviceId: string): Promise<DeviceSession[]> {
    return Promise.resolve(
      [...this.#byId.values()]
        .filter((session) => session.deviceId === deviceId)
        .map((session) => structuredClone(session)),
    );
  }
}

export interface DeviceSessionServiceOptions {
  registry: DeviceRegistry;
  store?: DeviceSessionStore;
  verifier?: SignatureVerifier;
  /** Session token lifetime. */
  sessionTtlMs?: number;
  /** Challenge nonce validity window. */
  challengeTtlMs?: number;
  /** Tolerated clock skew on request timestamps. */
  clockSkewMs?: number;
  now?: () => Date;
  newId?: () => string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class DeviceSessionService {
  readonly #registry: DeviceRegistry;
  readonly #store: DeviceSessionStore;
  readonly #verify: SignatureVerifier;
  readonly #sessionTtlMs: number;
  readonly #challengeTtlMs: number;
  readonly #clockSkewMs: number;
  readonly #now: () => Date;
  readonly #newId: () => string;

  /** Active challenges, consumed on first verification. */
  readonly #challenges = new Map<string, Challenge>();
  /** Seen nonces for replay prevention. */
  readonly #usedNonces = new Map<string, number>();

  constructor(options: DeviceSessionServiceOptions) {
    this.#registry = options.registry;
    this.#store = options.store ?? new InMemoryDeviceSessionStore();
    this.#verify = options.verifier ?? ed25519Verifier;
    this.#sessionTtlMs = options.sessionTtlMs ?? 30 * 60_000;
    this.#challengeTtlMs = options.challengeTtlMs ?? 60_000;
    this.#clockSkewMs = options.clockSkewMs ?? 30_000;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? uuidv7;
  }

  /**
   * Issues a cryptographic challenge for a device.
   *
   * Proves device private key possession without transmitting shared secrets.
   */
  async createChallenge(deviceId: string): Promise<Challenge> {
    const device = await this.#registry.requireDevice(deviceId);
    if (device.trust === "REVOKED" || device.revokedAt !== null) {
      throw new DeviceAuthenticationError(deviceId, "device revoked");
    }

    const now = this.#now();
    const challenge: Challenge = {
      deviceId,
      nonce: randomBytes(32).toString("base64url"),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + this.#challengeTtlMs),
    };

    this.#challenges.set(challenge.nonce, challenge);
    this.#pruneExpired(now);
    return challenge;
  }

  /**
   * Verifies challenge signature and opens an authenticated session.
   *
   * Negotiated capabilities are bounded by the device's registered capability set.
   */
  async authenticate(input: AuthenticateInput, credentialMaterial: string): Promise<IssuedSession> {
    const now = this.#now();
    const device = await this.#registry.requireDevice(input.deviceId);

    if (device.trust === "REVOKED" || device.revokedAt !== null) {
      throw new DeviceAuthenticationError(input.deviceId, "device revoked");
    }
    if (device.trust !== "TRUSTED") {
      throw new DeviceAuthenticationError(input.deviceId, "device not yet approved");
    }

    const challenge = this.#challenges.get(input.nonce);
    if (challenge === undefined) {
      throw new ReplayRejectedError({
        message: `Nonce unknown or already consumed for ${input.deviceId}`,
        context: { deviceId: input.deviceId },
      });
    }
    this.#challenges.delete(input.nonce);

    if (challenge.deviceId !== input.deviceId) {
      throw new ReplayRejectedError({
        message: "Nonce issued for a different device",
        context: { deviceId: input.deviceId },
      });
    }
    if (challenge.expiresAt.getTime() <= now.getTime()) {
      throw new ReplayRejectedError({
        message: "Challenge expired",
        context: { deviceId: input.deviceId },
      });
    }

    if (!this.#verify(credentialMaterial, input.nonce, input.signature)) {
      throw new DeviceAuthenticationError(input.deviceId, "invalid signature");
    }

    const declared = new Set(device.capabilities.filter((c) => c.enabled).map((c) => c.name));
    const negotiated =
      input.capabilities === undefined
        ? [...declared]
        : input.capabilities.filter((name) => declared.has(name));

    const token = randomBytes(32).toString("base64url");
    const session: DeviceSession = {
      id: this.#newId(),
      deviceId: device.id,
      userId: device.userId,
      tokenHash: hashToken(token),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + this.#sessionTtlMs),
      lastHeartbeatAt: now,
      rotatedFromId: null,
      revokedAt: null,
      capabilities: negotiated.sort(),
      remoteAddress: input.remoteAddress ?? null,
    };

    await this.#store.save(session);
    await this.#registry.setAuthenticated(device.id, true);
    await this.#registry.updateHeartbeat(device.id);

    return { session, token };
  }

  /**
   * Resolves bearer token to active device session.
   *
   * Returns `undefined` if invalid or expired.
   */
  async resolve(token: string): Promise<DeviceSession | undefined> {
    const session = await this.#store.findByTokenHash(hashToken(token));
    if (session === undefined) return undefined;
    if (!isSessionActive(session, this.#now())) return undefined;

    const device = await this.#registry.getDevice(session.deviceId);
    if (device?.trust !== "TRUSTED" || device.revokedAt !== null) {
      return undefined;
    }
    return session;
  }

  /**
   * Rotates session token.
   *
   * Previous token is revoked atomically during rotation.
   */
  async rotate(currentToken: string): Promise<IssuedSession> {
    const current = await this.resolve(currentToken);
    if (current === undefined) {
      throw new DeviceAuthenticationError("unknown", "invalid or expired session token");
    }

    const now = this.#now();
    const token = randomBytes(32).toString("base64url");
    const rotated: DeviceSession = {
      ...current,
      id: this.#newId(),
      tokenHash: hashToken(token),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + this.#sessionTtlMs),
      lastHeartbeatAt: now,
      rotatedFromId: current.id,
    };

    await this.#store.save({ ...current, revokedAt: now });
    await this.#store.save(rotated);
    return { session: rotated, token };
  }

  async heartbeat(token: string): Promise<DeviceSession | undefined> {
    const session = await this.resolve(token);
    if (session === undefined) return undefined;

    const updated: DeviceSession = { ...session, lastHeartbeatAt: this.#now() };
    await this.#store.save(updated);
    await this.#registry.updateHeartbeat(session.deviceId);
    return updated;
  }

  /** Revokes a session, marking device unauthenticated if no active sessions remain. */
  async revokeSession(sessionId: string): Promise<void> {
    const session = await this.#store.get(sessionId);
    if (session === undefined) return;

    await this.#store.save({ ...session, revokedAt: this.#now() });
    await this.#registry.setAuthenticated(session.deviceId, false);
  }

  /** Revokes all active sessions for a device. */
  async revokeAllForDevice(deviceId: string): Promise<number> {
    const sessions = await this.#store.listByDevice(deviceId);
    const now = this.#now();
    let revoked = 0;

    for (const session of sessions) {
      if (session.revokedAt !== null) continue;
      await this.#store.save({ ...session, revokedAt: now });
      revoked += 1;
    }

    await this.#registry.setAuthenticated(deviceId, false);
    return revoked;
  }

  /**
   * Validates signed request timestamp and unique nonce.
   */
  assertNotReplayed(requestId: string, timestamp: Date): void {
    const now = this.#now().getTime();
    const drift = Math.abs(now - timestamp.getTime());

    if (drift > this.#clockSkewMs) {
      throw new ReplayRejectedError({
        message: `Timestamp outside accepted window (${String(Math.round(drift / 1000))} s drift)`,
        context: { requestId },
      });
    }

    if (this.#usedNonces.has(requestId)) {
      throw new ReplayRejectedError({
        message: "Request ID already used",
        context: { requestId },
      });
    }

    this.#usedNonces.set(requestId, now);
    this.#pruneExpired(this.#now());
  }

  /** Constant-time token comparison helper. */
  static tokensMatch(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  #pruneExpired(now: Date): void {
    const cutoff = now.getTime() - this.#clockSkewMs * 2;
    for (const [requestId, seenAt] of this.#usedNonces) {
      if (seenAt < cutoff) this.#usedNonces.delete(requestId);
    }
    for (const [nonce, challenge] of this.#challenges) {
      if (challenge.expiresAt.getTime() <= now.getTime()) this.#challenges.delete(nonce);
    }
  }
}
