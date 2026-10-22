import type { Envelope } from "@nexus/protocol";
import type { WorkerConnection } from "@nexus/devices";
import type { ServiceContainer } from "../services/container.js";

/**
 * Real-time worker channel.
 *
 * Intentionally thin: **all logic already lives in `WorkerGateway`**, which
 * exposes it behind a single entrypoint, `handleMessage`. This module merely
 * connects a socket to that entrypoint and manages teardown.
 *
 * Two properties guaranteed by this split:
 *
 *  - A worker **never** reaches the client channel, and vice versa. The two
 *    channels have disjoint entrypoints, schemas, and types; a `worker.task_result`
 *    forged from a phone has nowhere to land;
 *  - Gateway logic is tested without network, and remains so. This file
 *    contains no decisions that would need to be re-verified here.
 */

export interface WorkerSocket {
  send(data: string): void;
  close(code: number, reason: string): void;
  remoteAddress?: string;
}

export interface WorkerChannelOptions {
  services: ServiceContainer;
  onError?: (error: unknown, deviceId: string) => void;
}

/**
 * A worker connection being established.
 *
 * `deviceId` is populated as of `worker.hello` — **it authenticates nothing**.
 * It serves solely to route handshake responses to the right socket.
 * Authentication itself hinges on the challenge signature, verified by `DeviceSessionService`.
 */
interface AttachedWorker {
  socket: WorkerSocket;
  deviceId: string;
}

export class WorkerChannel {
  readonly #services: ServiceContainer;
  readonly #onError: WorkerChannelOptions["onError"];

  readonly #attached = new Map<string, AttachedWorker>();

  constructor(options: WorkerChannelOptions) {
    this.#services = options.services;
    this.#onError = options.onError;
  }

  get attachedCount(): number {
    return this.#attached.size;
  }

  /**
   * Has this socket proven its identity?
   *
   * The answer does not come from a local flag: it comes from the gateway,
   * which alone knows if the challenge was signed. A local boolean could drift
   * from reality, and a transport that believes a machine is authenticated
   * when it is not is exactly the bug we want to avoid.
   */
  isAuthenticated(connectionId: string): boolean {
    // The response comes from the gateway, which alone knows if the challenge
    // was signed — and it answers **for this socket**, not for the device.
    // Two sockets may claim the same device; only one has signed.
    return this.#services.gateway.authenticatedDeviceId(connectionId) !== undefined;
  }

  /**
   * Opens a channel for a newly arrived socket.
   *
   * `connectionId` identifies the socket, not the device: two sockets could claim
   * the same `deviceId` before authentication, and conflating them would allow one
   * to receive frames intended for the other.
   */
  open(connectionId: string, socket: WorkerSocket): void {
    this.#attached.set(connectionId, { socket, deviceId: "" });
  }

  /**
   * Handles an upstream frame from an executor.
   *
   * Everything flows through `WorkerGateway.handleMessage`: hello, authentication,
   * capability registration, heartbeats, progress, and results. This module interprets nothing.
   */
  async handle(connectionId: string, raw: unknown): Promise<void> {
    const attached = this.#attached.get(connectionId);
    if (attached === undefined) return;

    // The announced `deviceId` is used to address responses. The gateway places
    // no trust in it: it requires a signature before opening anything.
    const announced = declaredDeviceId(raw);
    if (announced !== undefined && attached.deviceId === "") {
      attached.deviceId = announced;
    }

    const connection: WorkerConnection = {
      connectionId,
      // Announced by the peer. The gateway only uses this to address the
      // challenge response; it accords it no authority.
      deviceId: attached.deviceId,
      send: (envelope: Envelope) => {
        attached.socket.send(JSON.stringify(envelope));
      },
      close: (code, reason) => {
        attached.socket.close(code, reason);
      },
      ...(attached.socket.remoteAddress === undefined
        ? {}
        : { remoteAddress: attached.socket.remoteAddress }),
    };

    try {
      await this.#services.gateway.handleMessage(connection, raw);
    } catch (cause) {
      // A rejected frame — invalid signature, revoked device, replay — closes
      // the connection. An executor presenting bad credentials has no business
      // on this channel, and allowing it to retry in a loop on the same socket
      // would turn the rejection into a mere slowdown.
      this.#onError?.(cause, attached.deviceId);
      attached.socket.close(4401, "authentication rejected");
      await this.close(connectionId, "authentication rejected");
    }
  }

  /**
   * Closes a channel.
   *
   * Gateway detachment is what releases in-flight steps: without it, the
   * coordinator would wait for their full timeout before understanding that the
   * machine has disappeared, whereas it can reassign them immediately elsewhere.
   */
  async close(connectionId: string, reason: string): Promise<void> {
    const attached = this.#attached.get(connectionId);
    if (attached === undefined) return;

    this.#attached.delete(connectionId);

    // Detachment **by connection**, never by announced identifier: a socket
    // that merely stated a public identifier must not be able to take the
    // corresponding device offline by disconnecting.
    await this.#services.gateway.detachConnection(connectionId, reason);
  }
}

/**
 * Extracts `deviceId` from a handshake frame.
 *
 * Without validation: this is deliberate, the gateway validates. Here we only
 * want to know where to send the challenge back.
 */
function declaredDeviceId(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object") return undefined;

  const payload = (raw as { payload?: unknown }).payload;
  if (payload === null || typeof payload !== "object") return undefined;

  const deviceId = (payload as { deviceId?: unknown }).deviceId;
  return typeof deviceId === "string" && deviceId.length > 0 ? deviceId : undefined;
}
