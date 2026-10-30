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
  data?: unknown | undefined;
}

export interface SatelliteView extends SatelliteHeartbeat {
  lastSeenAt: string;
  online: boolean;
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
  readonly #now: () => number;

  constructor(tokenHashes: Readonly<Record<string, string>>, now: () => number = Date.now) {
    this.#tokenHashes = tokenHashes;
    this.#now = now;
  }

  authenticate(deviceId: string, authorization: string | undefined): boolean {
    const expectedHex = this.#tokenHashes[deviceId];
    if (expectedHex === undefined || !/^[0-9a-f]{64}$/i.test(expectedHex)) return false;
    const prefix = "Bearer ";
    if (authorization === undefined || !authorization.startsWith(prefix)) return false;
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
      const existing = queue.find((item) => item.correlationId === idempotencyKey);
      if (existing !== undefined) return existing;
    }
    const item: SatelliteCommand = {
      v: 1,
      type: "command",
      correlationId: idempotencyKey ?? randomUUID(),
      command,
      params,
      ts: this.#now(),
    };
    queue.push(item);
    this.#commands.set(deviceId, queue);
    return item;
  }

  next(deviceId: string): SatelliteCommand | undefined {
    const queue = this.#commands.get(deviceId);
    return queue?.shift();
  }

  acceptResult(result: SatelliteCommandResult): void {
    this.#results.set(result.correlationId, result);
  }

  result(correlationId: string): SatelliteCommandResult | undefined {
    return this.#results.get(correlationId);
  }

  #view(heartbeat: SatelliteHeartbeat, lastSeenAt: number): SatelliteView {
    return {
      ...heartbeat,
      lastSeenAt: new Date(lastSeenAt).toISOString(),
      online: this.#now() - lastSeenAt <= 90_000,
    };
  }
}
