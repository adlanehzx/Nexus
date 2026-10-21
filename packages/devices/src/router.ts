import { uuidv7 } from "@nexus/shared";
import {
  EVENT_SCHEMA_VERSION,
  nexusEventSchema,
  type NexusEvent,
  type NexusEventType,
} from "@nexus/protocol";
import type { DeviceRegistry } from "./registry.js";
import { canReceiveEvents, type Device } from "./types.js";

/**
 * Event routing and device synchronization.
 *
 * Routing semantics:
 * 1. Origin client receives first to maximize UI responsiveness.
 * 2. All client devices belonging to the user receive synchronization events.
 *
 * Synchronization routes strictly through Core. No direct peer-to-peer communication.
 */

/** Channel to a connected client. */
export interface ClientConnection {
  deviceId: string;
  userId: string;
  send(event: NexusEvent): void | Promise<void>;
}

export interface DeliveryReport {
  event: NexusEvent;
  /** Client device IDs that received the event directly. */
  deliveredTo: string[];
  /** Registered client devices currently offline; event queued in memory backlog. */
  queuedFor: string[];
  /** True if originating client device was reachable. */
  originReached: boolean;
}

/** In-memory delivery queue options for offline devices. */
export interface PendingQueueOptions {
  maxPerDevice?: number;
}

export interface EventRouterOptions {
  registry: DeviceRegistry;
  queue?: PendingQueueOptions;
  now?: () => Date;
  newId?: () => string;
  /** Audit notification callback. Receives validated event. */
  onPublished?: (report: DeliveryReport) => void;
}

export interface EmitInput {
  type: NexusEventType;
  userId: string;
  correlationId: string;
  originClientDeviceId?: string | null;
  payload: Record<string, unknown>;
}

export class EventRouter {
  readonly #registry: DeviceRegistry;
  readonly #connections = new Map<string, ClientConnection>();
  readonly #pending = new Map<string, NexusEvent[]>();
  readonly #maxPerDevice: number;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #onPublished: ((report: DeliveryReport) => void) | undefined;

  constructor(options: EventRouterOptions) {
    this.#registry = options.registry;
    this.#maxPerDevice = options.queue?.maxPerDevice ?? 200;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? uuidv7;
    this.#onPublished = options.onPublished;
  }

  // ── Connections ─────────────────────────────────────────────────────────

  /**
   * Attaches client connection and flushes queued backlog.
   */
  async attach(connection: ClientConnection): Promise<NexusEvent[]> {
    this.#connections.set(connection.deviceId, connection);

    const backlog = this.#pending.get(connection.deviceId) ?? [];
    this.#pending.delete(connection.deviceId);

    for (const event of backlog) await connection.send(event);
    return backlog;
  }

  detach(deviceId: string): void {
    this.#connections.delete(deviceId);
  }

  isConnected(deviceId: string): boolean {
    return this.#connections.has(deviceId);
  }

  get connectedDeviceIds(): string[] {
    return [...this.#connections.keys()];
  }

  // ── Publication ─────────────────────────────────────────────────────────

  /**
   * Constructs, validates, and broadcasts an event to user's client devices.
   */
  async emit(input: EmitInput): Promise<DeliveryReport> {
    const event = nexusEventSchema.parse({
      v: EVENT_SCHEMA_VERSION,
      id: this.#newId(),
      type: input.type,
      at: this.#now().toISOString(),
      userId: input.userId,
      correlationId: input.correlationId,
      originClientDeviceId: input.originClientDeviceId ?? null,
      ...input.payload,
    });

    return this.publish(event);
  }

  /** Broadcasts a pre-constructed event. */
  async publish(event: NexusEvent): Promise<DeliveryReport> {
    const clients = await this.#registry.getClientDevices(event.userId);
    const targets = this.#orderTargets(clients, event.originClientDeviceId);

    const deliveredTo: string[] = [];
    const queuedFor: string[] = [];

    for (const device of targets) {
      const connection = this.#connections.get(device.id);
      if (connection === undefined) {
        this.#enqueue(device.id, event);
        queuedFor.push(device.id);
        continue;
      }

      try {
        await connection.send(event);
        deliveredTo.push(device.id);
      } catch {
        this.detach(device.id);
        this.#enqueue(device.id, event);
        queuedFor.push(device.id);
      }
    }

    const report: DeliveryReport = {
      event,
      deliveredTo,
      queuedFor,
      originReached:
        event.originClientDeviceId === null || deliveredTo.includes(event.originClientDeviceId),
    };

    try {
      this.#onPublished?.(report);
    } catch {
      // Audit handler errors must not fail dispatch
    }
    return report;
  }

  /**
   * Dispatches direct event to a single device without queueing.
   */
  async sendTo(deviceId: string, event: NexusEvent): Promise<boolean> {
    const connection = this.#connections.get(deviceId);
    if (connection === undefined) return false;

    try {
      await connection.send(event);
      return true;
    } catch {
      this.detach(deviceId);
      return false;
    }
  }

  /** Returns pending queue for a device (testing and diagnostics). */
  pendingFor(deviceId: string): readonly NexusEvent[] {
    return this.#pending.get(deviceId) ?? [];
  }

  /** Orders targets prioritizing originating client. */
  #orderTargets(clients: readonly Device[], originId: string | null): Device[] {
    const eligible = clients.filter((device) => canReceiveEvents(device.role));
    if (originId === null) return eligible;

    const origin = eligible.filter((device) => device.id === originId);
    const others = eligible.filter((device) => device.id !== originId);
    return [...origin, ...others];
  }

  #enqueue(deviceId: string, event: NexusEvent): void {
    const queue = this.#pending.get(deviceId) ?? [];
    queue.push(event);

    if (queue.length > this.#maxPerDevice) queue.splice(0, queue.length - this.#maxPerDevice);
    this.#pending.set(deviceId, queue);
  }
}
