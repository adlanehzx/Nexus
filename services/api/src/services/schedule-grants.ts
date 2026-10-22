import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AuthenticationError, AuthorizationError } from "@nexus/shared";
import type { IssuedMissionGrant, MissionGrantService } from "./mission-grants.js";

export interface ScheduleGrantRecord {
  id: string;
  tokenHash: string;
  userId: string;
  missionExternalKey: string;
  scheduleId: string;
  status: "ACTIVE" | "REVOKED";
  createdAt: Date;
  revokedAt: Date | null;
}

export interface ScheduleGrantRegistry {
  record(record: ScheduleGrantRecord): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<ScheduleGrantRecord | undefined>;
  revoke(id: string, at: Date): Promise<void>;
}

export class InMemoryScheduleGrantRegistry implements ScheduleGrantRegistry {
  readonly #records = new Map<string, ScheduleGrantRecord>();

  record(record: ScheduleGrantRecord): Promise<void> {
    this.#records.set(record.id, { ...record });
    return Promise.resolve();
  }

  findByTokenHash(tokenHash: string): Promise<ScheduleGrantRecord | undefined> {
    return Promise.resolve(
      [...this.#records.values()].find((item) => item.tokenHash === tokenHash),
    );
  }

  revoke(id: string, at: Date): Promise<void> {
    const record = this.#records.get(id);
    if (record?.status === "ACTIVE") {
      this.#records.set(id, { ...record, status: "REVOKED", revokedAt: at });
    }
    return Promise.resolve();
  }
}

export class ScheduleGrantService {
  readonly #registry: ScheduleGrantRegistry;
  readonly #missions: MissionGrantService;
  readonly #now: () => Date;
  readonly #isUserActive: (userId: string) => Promise<boolean>;

  constructor(options: {
    registry: ScheduleGrantRegistry;
    missions: MissionGrantService;
    isUserActive: (userId: string) => Promise<boolean>;
    now?: () => Date;
  }) {
    this.#registry = options.registry;
    this.#missions = options.missions;
    this.#isUserActive = options.isUserActive;
    this.#now = options.now ?? (() => new Date());
  }

  async issue(input: { userId: string; missionExternalKey: string; scheduleId: string }): Promise<{
    id: string;
    token: string;
  }> {
    const id = randomUUID();
    const token = `nsg_${randomBytes(32).toString("base64url")}`;
    await this.#registry.record({
      id,
      tokenHash: hash(token),
      userId: input.userId,
      missionExternalKey: input.missionExternalKey,
      scheduleId: input.scheduleId,
      status: "ACTIVE",
      createdAt: this.#now(),
      revokedAt: null,
    });
    return { id, token };
  }

  revoke(id: string): Promise<void> {
    return this.#registry.revoke(id, this.#now());
  }

  async exchange(input: {
    token: string;
    scheduleId: string;
    scheduledFor: string;
    missionExternalKey: string;
  }): Promise<{ owner: { userId: string } } & IssuedMissionGrant> {
    const record = await this.#registry.findByTokenHash(hash(input.token));
    if (record?.status !== "ACTIVE") {
      throw invalidDelegation("unknown or revoked delegation");
    }
    if (record.scheduleId !== input.scheduleId) {
      throw invalidDelegation("delegation used for a different schedule");
    }
    const expected = scheduledExternalKey(
      record.missionExternalKey,
      input.scheduleId,
      input.scheduledFor,
    );
    if (expected !== input.missionExternalKey) {
      throw new AuthorizationError({
        message: "Schedule delegation does not cover this occurrence",
        userMessage: "Access denied.",
      });
    }
    if (!(await this.#isUserActive(record.userId))) {
      throw new AuthorizationError({
        message: `Schedule delegation for an inactive account: ${record.userId}`,
        userMessage: "Access denied.",
      });
    }
    const grant = await this.#missions.issue({
      userId: record.userId,
      service: "mission-engine",
      missionExternalKey: input.missionExternalKey,
    });
    return { owner: { userId: record.userId }, ...grant };
  }
}

export function scheduledExternalKey(
  base: string,
  scheduleId: string,
  scheduledFor: string,
): string {
  const compact = scheduledFor.replaceAll("-", "").replaceAll(":", "").replace("+00:00", "Z");
  const suffix = `:${scheduleId.slice(0, 8)}:${compact}`;
  if (base.length + suffix.length <= 128) return base + suffix;
  const digest = createHash("sha256")
    .update(`${scheduleId}:${scheduledFor}`)
    .digest("hex")
    .slice(0, 16);
  return `${base.slice(0, 110)}:${digest}`;
}

function hash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function invalidDelegation(reason: string): AuthenticationError {
  return new AuthenticationError({
    message: `Schedule delegation rejected: ${reason}`,
    userMessage: "Authentication required.",
  });
}
