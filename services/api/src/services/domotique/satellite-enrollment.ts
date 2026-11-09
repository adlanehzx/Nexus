import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@nexus/database";
import { AppError, ConflictError, NotFoundError, ValidationError } from "@nexus/shared";

/**
 * Network enrolment of ESP32 satellites — any device, any household, no
 * hand-written configuration.
 *
 *  1. A fresh satellite generates a random enrolment secret (kept in its NVS),
 *     finds NEXUS on the LAN (mDNS `_nexus._tcp`) and announces itself.
 *  2. NEXUS lists it as "pending" in every dashboard of this instance, with a
 *     6-digit verification code. The device derives the same code from its
 *     secret and shows it (speaker, LED, display or serial console).
 *  3. A user compares the codes and approves: that user becomes the owner.
 *  4. The device polls with its secret and receives its token exactly once.
 *
 * Only SHA-256 digests of the secret and of the token are kept. Someone else
 * on the LAN announcing the same device id gets a different code, and cannot
 * fetch the token without the original secret.
 */

export type SatelliteEnrollmentStatus = "pending" | "approved";

export interface SatelliteEnrollmentRecord {
  readonly deviceId: string;
  readonly ownerId: string | null;
  readonly name: string;
  readonly status: SatelliteEnrollmentStatus;
  readonly enrollSecretHash: string;
  readonly verificationCode: string;
  readonly tokenHash: string | null;
  readonly tokenDelivered: boolean;
  readonly firmware: string | null;
  readonly capabilities: readonly { name: string }[];
  readonly roomId: string | null;
  readonly sourceIp: string | null;
  readonly createdAt: string;
  readonly approvedAt: string | null;
}

export interface SatelliteEnrollmentStore {
  list(): Promise<SatelliteEnrollmentRecord[]>;
  save(record: SatelliteEnrollmentRecord): Promise<void>;
  delete(deviceId: string): Promise<void>;
}

export class InMemorySatelliteEnrollmentStore implements SatelliteEnrollmentStore {
  readonly #records = new Map<string, SatelliteEnrollmentRecord>();
  list() {
    return Promise.resolve([...this.#records.values()]);
  }
  save(record: SatelliteEnrollmentRecord) {
    this.#records.set(record.deviceId, record);
    return Promise.resolve();
  }
  delete(deviceId: string) {
    this.#records.delete(deviceId);
    return Promise.resolve();
  }
}

export class PrismaSatelliteEnrollmentStore implements SatelliteEnrollmentStore {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async list(): Promise<SatelliteEnrollmentRecord[]> {
    const rows = await this.#prisma.homeSatellite.findMany();
    return rows.map((r) => ({
      deviceId: r.deviceId,
      ownerId: r.ownerId,
      name: r.name,
      status: r.status === "approved" ? "approved" : "pending",
      enrollSecretHash: r.enrollSecretHash,
      verificationCode: r.verificationCode,
      tokenHash: r.tokenHash,
      tokenDelivered: r.tokenDelivered,
      firmware: r.firmware,
      capabilities: Array.isArray(r.capabilities)
        ? (r.capabilities as { name?: unknown }[])
            .filter((c) => typeof c.name === "string")
            .map((c) => ({ name: String(c.name) }))
        : [],
      roomId: r.roomId,
      sourceIp: r.sourceIp,
      createdAt: r.createdAt.toISOString(),
      approvedAt: r.approvedAt === null ? null : r.approvedAt.toISOString(),
    }));
  }

  async save(record: SatelliteEnrollmentRecord): Promise<void> {
    const data = {
      ownerId: record.ownerId,
      name: record.name,
      status: record.status,
      enrollSecretHash: record.enrollSecretHash,
      verificationCode: record.verificationCode,
      tokenHash: record.tokenHash,
      tokenDelivered: record.tokenDelivered,
      firmware: record.firmware,
      capabilities: record.capabilities as never,
      roomId: record.roomId,
      sourceIp: record.sourceIp,
      approvedAt: record.approvedAt === null ? null : new Date(record.approvedAt),
    };
    await this.#prisma.homeSatellite.upsert({
      where: { deviceId: record.deviceId },
      create: { deviceId: record.deviceId, ...data, createdAt: new Date(record.createdAt) },
      update: data,
    });
  }

  async delete(deviceId: string): Promise<void> {
    await this.#prisma.homeSatellite.deleteMany({ where: { deviceId } });
  }
}

export class EnrollmentRateLimitedError extends AppError {
  readonly code = "ENROLLMENT_LIMIT";
  readonly httpStatus = 429;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * The code both sides compute from the enrolment secret. Firmware:
 * `HMAC-SHA256(key = secret bytes as UTF-8, message = "nexus-satellite-verify")`,
 * first 4 bytes big-endian, modulo 1 000 000, zero-padded to 6 digits.
 */
export function satelliteVerificationCode(enrollSecret: string): string {
  const digest = createHmac("sha256", enrollSecret).update("nexus-satellite-verify").digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

function sameHash(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface SatelliteEnrollmentOptions {
  readonly store: SatelliteEnrollmentStore;
  readonly now?: () => Date;
  /** A pending announcement is forgotten after this delay. */
  readonly pendingTtlMs?: number;
  readonly maxPending?: number;
  readonly newToken?: () => string;
}

export type AnnounceResult =
  | { status: "pending"; verificationCode: string; pollAfterMs: number }
  | { status: "approved"; token: string }
  | { status: "enrolled" };

export class SatelliteEnrollmentService {
  readonly #o: SatelliteEnrollmentOptions;
  readonly #now: () => Date;
  readonly #records = new Map<string, SatelliteEnrollmentRecord>();
  #loaded: Promise<void> | undefined;

  constructor(options: SatelliteEnrollmentOptions) {
    this.#o = options;
    this.#now = options.now ?? (() => new Date());
  }

  /** Hydrates the in-memory view used by synchronous token checks. Idempotent. */
  load(): Promise<void> {
    this.#loaded ??= this.#o.store.list().then((records) => {
      for (const record of records) this.#records.set(record.deviceId, record);
    });
    return this.#loaded;
  }

  // ── Synchronous registry view (SatelliteService) ────────────────────────

  tokenHash(deviceId: string): string | undefined {
    const record = this.#records.get(deviceId);
    return record?.status === "approved" ? (record.tokenHash ?? undefined) : undefined;
  }

  owner(deviceId: string): string | undefined {
    const record = this.#records.get(deviceId);
    return record?.status === "approved" ? (record.ownerId ?? undefined) : undefined;
  }

  // ── Device side ──────────────────────────────────────────────────────────

  async announce(input: {
    deviceId: string;
    name: string;
    enrollSecret: string;
    firmware?: string | undefined;
    capabilities?: readonly { name: string }[] | undefined;
    sourceIp?: string | undefined;
  }): Promise<AnnounceResult> {
    await this.load();
    const secretHash = sha256(input.enrollSecret);
    const existing = this.#records.get(input.deviceId);
    if (existing?.status === "approved") {
      if (!sameHash(existing.enrollSecretHash, secretHash)) {
        throw new ConflictError({
          message: `satellite ${input.deviceId} already enrolled`,
          userMessage:
            "This satellite id is already enrolled. Remove it from the dashboard to enrol it again.",
        });
      }
      return existing.tokenDelivered ? { status: "enrolled" } : this.#deliver(existing);
    }
    this.#forgetExpired();
    const pending = [...this.#records.values()].filter((r) => r.status === "pending").length;
    if (existing === undefined && pending >= (this.#o.maxPending ?? 20)) {
      throw new EnrollmentRateLimitedError({
        message: "too many pending satellites",
        userMessage: "Too many satellites are waiting for approval. Approve or reject some first.",
      });
    }
    const record: SatelliteEnrollmentRecord = {
      deviceId: input.deviceId,
      ownerId: null,
      name: input.name,
      status: "pending",
      enrollSecretHash: secretHash,
      verificationCode: satelliteVerificationCode(input.enrollSecret),
      tokenHash: null,
      tokenDelivered: false,
      firmware: input.firmware ?? null,
      capabilities: [...(input.capabilities ?? [])],
      roomId: existing?.roomId ?? null,
      sourceIp: input.sourceIp ?? null,
      createdAt: this.#now().toISOString(),
      approvedAt: null,
    };
    await this.#save(record);
    return { status: "pending", verificationCode: record.verificationCode, pollAfterMs: 3_000 };
  }

  /** Device polls until approved; the token is returned exactly once. */
  async poll(input: {
    deviceId: string;
    enrollSecret: string;
  }): Promise<AnnounceResult | { status: "unknown" }> {
    await this.load();
    const record = this.#records.get(input.deviceId);
    if (record === undefined || !sameHash(record.enrollSecretHash, sha256(input.enrollSecret))) {
      // Same answer for "never announced", "rejected" and "wrong secret".
      return { status: "unknown" };
    }
    if (record.status === "pending") {
      return { status: "pending", verificationCode: record.verificationCode, pollAfterMs: 3_000 };
    }
    return record.tokenDelivered ? { status: "enrolled" } : this.#deliver(record);
  }

  // ── User side ────────────────────────────────────────────────────────────

  async pending(): Promise<SatelliteEnrollmentRecord[]> {
    await this.load();
    this.#forgetExpired();
    return [...this.#records.values()]
      .filter((r) => r.status === "pending")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async owned(userId: string): Promise<SatelliteEnrollmentRecord[]> {
    await this.load();
    return [...this.#records.values()].filter(
      (r) => r.status === "approved" && r.ownerId === userId,
    );
  }

  async approve(
    userId: string,
    deviceId: string,
    input: {
      verificationCode: string;
      name?: string | undefined;
      roomId?: string | null | undefined;
    },
  ): Promise<SatelliteEnrollmentRecord> {
    await this.load();
    const record = this.#records.get(deviceId);
    if (record?.status !== "pending") {
      throw new NotFoundError({
        message: `pending satellite ${deviceId}`,
        userMessage: "No satellite waiting with this id.",
      });
    }
    if (input.verificationCode.trim() !== record.verificationCode) {
      throw new ValidationError({
        message: "verification code mismatch",
        userMessage: "The code does not match the one announced by the satellite.",
      });
    }
    const approved: SatelliteEnrollmentRecord = {
      ...record,
      ownerId: userId,
      status: "approved",
      name: input.name === undefined || input.name.trim() === "" ? record.name : input.name.trim(),
      roomId: input.roomId === undefined ? record.roomId : input.roomId,
      approvedAt: this.#now().toISOString(),
    };
    await this.#save(approved);
    return approved;
  }

  async reject(deviceId: string): Promise<void> {
    await this.load();
    if (this.#records.get(deviceId)?.status !== "pending") return;
    this.#records.delete(deviceId);
    await this.#o.store.delete(deviceId);
  }

  /** Forgets an enrolled satellite: its token stops working immediately. */
  async remove(userId: string, deviceId: string): Promise<void> {
    await this.load();
    const record = this.#records.get(deviceId);
    if (record?.status !== "approved" || record.ownerId !== userId) {
      throw new NotFoundError({
        message: `satellite ${deviceId}`,
        userMessage: "Satellite not found.",
      });
    }
    this.#records.delete(deviceId);
    await this.#o.store.delete(deviceId);
  }

  async update(
    userId: string,
    deviceId: string,
    patch: { name?: string | undefined; roomId?: string | null | undefined },
  ): Promise<SatelliteEnrollmentRecord> {
    await this.load();
    const record = this.#records.get(deviceId);
    if (record?.status !== "approved" || record.ownerId !== userId) {
      throw new NotFoundError({
        message: `satellite ${deviceId}`,
        userMessage: "Satellite not found.",
      });
    }
    const next = {
      ...record,
      ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
      ...(patch.roomId === undefined ? {} : { roomId: patch.roomId }),
    };
    await this.#save(next);
    return next;
  }

  record(deviceId: string): SatelliteEnrollmentRecord | undefined {
    return this.#records.get(deviceId);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  async #deliver(record: SatelliteEnrollmentRecord): Promise<AnnounceResult> {
    const token = this.#o.newToken?.() ?? randomBytes(32).toString("base64url");
    await this.#save({ ...record, tokenHash: sha256(token), tokenDelivered: true });
    return { status: "approved", token };
  }

  async #save(record: SatelliteEnrollmentRecord): Promise<void> {
    await this.#o.store.save(record);
    this.#records.set(record.deviceId, record);
  }

  #forgetExpired(): void {
    const ttl = this.#o.pendingTtlMs ?? 24 * 3_600_000;
    const limit = this.#now().getTime() - ttl;
    for (const [id, record] of this.#records) {
      if (record.status === "pending" && Date.parse(record.createdAt) < limit) {
        this.#records.delete(id);
        void this.#o.store.delete(id).catch(() => undefined);
      }
    }
  }
}

/** True for loopback, RFC 1918, link-local, CGNAT/Tailscale and ULA addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const parts = v4.split(".").map(Number);
  if (parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)) {
    const [a, b] = parts as [number, number, number, number];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const lower = ip.toLowerCase();
  return (
    lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:")
  );
}
