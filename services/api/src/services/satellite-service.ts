import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

export const SATELLITE_COMMANDS = [
  "system.ping",
  "system.diagnostics",
  "system.capabilities",
  "led.set",
  "audio.privacy",
  "infrared.transmit",
] as const;

export type SatelliteCommandName = (typeof SATELLITE_COMMANDS)[number];

export interface SatelliteHeartbeat {
  v: 1;
  deviceId: string;
  name: string;
  health: Record<string, unknown>;
  capabilities: Record<string, unknown>[];
}

export interface SatelliteCommand {
  v: 1;
  type: "command";
  correlationId: string;
  command: SatelliteCommandName;
  params: Record<string, unknown>;
  ts: number;
}

export interface SatelliteCommandResult {
  v: 1;
  type: "command.result";
  correlationId: string;
  ok: boolean;
  status: number;
  message?: string | undefined;
  data?: unknown;
}

export interface SatelliteView extends SatelliteHeartbeat {
  lastSeenAt: string;
  online: boolean;
}

/**
 * Satellites enrolled from the network (dashboard approval). Consulted after
 * the static `SATELLITE_TOKEN_HASHES_JSON` map, which remains supported.
 */
export interface SatelliteRegistry {
  tokenHash(deviceId: string): string | undefined;
  owner(deviceId: string): string | undefined;
}

interface SatelliteRecord {
  heartbeat: SatelliteHeartbeat;
  lastSeenAt: number;
}

/**
 * Small constrained-device gateway. Device tokens are compared as SHA-256
 * digests, queues are isolated per device, and commands are strictly allowlisted.
 */
export class SatelliteService {
  readonly #tokenHashes: Readonly<Record<string, string>>;
  readonly #satellites = new Map<string, SatelliteRecord>();
  readonly #commands = new Map<string, SatelliteCommand[]>();
  readonly #results = new Map<string, SatelliteCommandResult>();
  readonly #issued = new Map<
    string,
    { command: SatelliteCommand; state: "queued" | "delivered" | "completed" }
  >();
  readonly #now: () => number;
  private readonly owners: Readonly<Record<string, string>>;
  #registry: SatelliteRegistry | undefined;

  constructor(
    tokenHashes: Readonly<Record<string, string>>,
    now: () => number = Date.now,
    owners: Readonly<Record<string, string>> = {},
  ) {
    this.#tokenHashes = tokenHashes;
    this.#now = now;
    this.owners = owners;
  }

  attachRegistry(registry: SatelliteRegistry): void {
    this.#registry = registry;
  }

  /** Owner of a paired satellite, or `undefined` when unknown or without a token. */
  ownerOf(deviceId: string): string | undefined {
    if (this.#tokenHashes[deviceId] !== undefined) return this.owners[deviceId];
    return this.#registry?.tokenHash(deviceId) === undefined
      ? undefined
      : this.#registry.owner(deviceId);
  }

  isOwnedBy(deviceId: string, userId: string): boolean {
    return this.ownerOf(deviceId) === userId;
  }

  /** True while the satellite still has a valid token (static or enrolled). */
  isKnown(deviceId: string): boolean {
    return (this.#tokenHashes[deviceId] ?? this.#registry?.tokenHash(deviceId)) !== undefined;
  }

  /** Forgets live state of a satellite that was removed. */
  forget(deviceId: string): void {
    this.#satellites.delete(deviceId);
    this.#commands.delete(deviceId);
  }

  authenticate(deviceId: string, authorization: string | undefined): boolean {
    const expectedHex = this.#tokenHashes[deviceId] ?? this.#registry?.tokenHash(deviceId);
    if (expectedHex === undefined || !/^[0-9a-f]{64}$/i.test(expectedHex)) return false;
    const prefix = "Bearer ";
    if (!authorization?.startsWith(prefix)) return false;
    const supplied = createHash("sha256").update(authorization.slice(prefix.length)).digest();
    const expected = Buffer.from(expectedHex, "hex");
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }

  heartbeat(value: SatelliteHeartbeat): SatelliteView {
    const lastSeenAt = this.#now();
    this.#satellites.set(value.deviceId, { heartbeat: value, lastSeenAt });
    return this.#view(value, lastSeenAt);
  }

  list(): SatelliteView[] {
    return [...this.#satellites.values()]
      .map(({ heartbeat, lastSeenAt }) => this.#view(heartbeat, lastSeenAt))
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  enqueue(
    deviceId: string,
    command: SatelliteCommandName,
    params: Record<string, unknown>,
    idempotencyKey?: string,
  ): SatelliteCommand {
    const queue = this.#commands.get(deviceId) ?? [];
    if (idempotencyKey !== undefined) {
      const existing = this.#issued.get(`${deviceId}:${idempotencyKey}`);
      if (existing !== undefined) return existing.command;
    }
    const item: SatelliteCommand = {
      v: 1,
      type: "command",
      correlationId: idempotencyKey ?? randomUUID(),
      command,
      params,
      ts: this.#now(),
    };
    this.#issued.set(`${deviceId}:${item.correlationId}`, { command: item, state: "queued" });
    queue.push(item);
    this.#commands.set(deviceId, queue);
    return item;
  }

  next(deviceId: string): SatelliteCommand | undefined {
    const queue = this.#commands.get(deviceId);
    const command = queue?.shift();
    if (command) {
      const issued = this.#issued.get(`${deviceId}:${command.correlationId}`);
      if (issued) issued.state = "delivered";
    }
    return command;
  }

  acceptResult(deviceId: string, result: SatelliteCommandResult): boolean {
    const key = `${deviceId}:${result.correlationId}`;
    const issued = this.#issued.get(key);
    if (!issued || issued.state === "queued") return false;
    if (issued.state !== "completed") {
      this.#results.set(key, result);
      issued.state = "completed";
    }
    return true;
  }

  result(deviceId: string, correlationId: string): SatelliteCommandResult | undefined {
    return this.#results.get(`${deviceId}:${correlationId}`);
  }

  commandStatus(deviceId: string, correlationId: string) {
    const issued = this.#issued.get(`${deviceId}:${correlationId}`);
    return issued === undefined
      ? undefined
      : {
          state: issued.state,
          result: this.result(deviceId, correlationId) ?? null,
        };
  }

  #view(heartbeat: SatelliteHeartbeat, lastSeenAt: number): SatelliteView {
    return {
      ...heartbeat,
      lastSeenAt: new Date(lastSeenAt).toISOString(),
      online: this.#now() - lastSeenAt <= 90_000,
    };
  }
}
