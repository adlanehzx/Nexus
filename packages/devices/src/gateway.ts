import { uuidv7 } from "@nexus/shared";
import {
  WORKER_MESSAGE,
  parseWorkerMessage,
  workerEnvelope,
  type Envelope,
  type WorkerHealth,
  type WorkerMessageType,
  type WorkerPayload,
} from "@nexus/protocol";
import { deviceCapabilitySchema, type DeviceCapability, type DeviceHealth } from "./types.js";
import { DeviceAuthenticationError } from "./errors.js";
import type { DeviceRegistry } from "./registry.js";
import type { DeviceSessionService } from "./sessions.js";
import type { EventRouter } from "./router.js";
import type { WorkerDispatch, WorkerResult, WorkerTransport } from "./coordinator.js";

/**
 * Worker gateway.
 *
 * Implements `WorkerTransport` declared by the coordinator.
 * Everything else remains unchanged Core-side: `TaskCoordinator`, `DeviceSelector`
 * and `TaskPlan` do not need to know whether a worker is local or remote.
 *
 * Connection direction is the critical architectural invariant. The worker initiates
 * connections to the Core; the Core cannot reach into worker machines. It responds
 * across the pre-established channel. Direct consequence: zero port forwarding, no
 * exposed attack surface, and workers behind residential NAT or mobile tethering
 * function without specialized network configuration.
 *
 * The gateway does not know about WebSockets directly: it talks to `WorkerConnection`,
 * a port abstraction. Concrete transports bind to it without modifying this logic.
 */

/**
 * Maximum challenges a single socket can request.
 *
 * Three challenges comfortably accommodate reconnection attempts after an expired challenge.
 * Beyond three, it represents abusive behavior: each nonce is tracked for one minute,
 * and challenge requests precede authentication.
 */
const MAX_HELLO_PER_CONNECTION = 3;

/** Channel opened by a worker. */
export interface WorkerConnection {
  /**
   * Socket identifier, assigned by transport.
   *
   * Distinct from `deviceId`: `deviceId` is claimed by the peer in its initial handshake
   * frame and is public. `connectionId` identifies the physical connection, which the
   * gateway associates with a verified device only after cryptographic validation.
   *
   * Without this separation, an unauthenticated socket claiming an existing `deviceId`
   * could masquerade as that device.
   */
  connectionId: string;
  /** What the peer claims to be. Used to address responses, nothing else. */
  deviceId: string;
  send(envelope: Envelope): void | Promise<void>;
  close(code: number, reason: string): void | Promise<void>;
  /** Remote IP address for session audit traces. Never logged in isolation. */
  remoteAddress?: string;
}

/**
 * Provides cryptographic credentials for a device.
 *
 * Separated from the registry: public keys have distinct lifecycles and revocation
 * policies from device metadata, allowing future backing by specialized secret vaults.
 */
export interface DeviceCredentialProvider {
  /** Device PEM public key, or `undefined` if none registered. */
  publicKeyFor(deviceId: string): Promise<string | undefined>;
}

/**
 * Registration and removal of device public keys.
 *
 * Distinct from `DeviceCredentialProvider`: the gateway requires read-only access,
 * and a read-only interface prevents unintended writes. Registration routes require
 * write capabilities, enforcing least-privilege interfaces.
 */
export interface DeviceCredentialStore extends DeviceCredentialProvider {
  set(deviceId: string, publicKeyPem: string): Promise<void> | void;
  /**
   * Removes a device's public key upon revocation.
   *
   * Primary defense is trust status; key deletion serves as a secondary defense-in-depth
   * measure to render handshakes cryptographically impossible.
   */
  revoke(deviceId: string): Promise<void> | void;
}

export class InMemoryCredentialProvider implements DeviceCredentialStore {
  readonly #keys = new Map<string, string>();

  set(deviceId: string, publicKeyPem: string): void {
    this.#keys.set(deviceId, publicKeyPem);
  }

  revoke(deviceId: string): void {
    this.#keys.delete(deviceId);
  }

  publicKeyFor(deviceId: string): Promise<string | undefined> {
    return Promise.resolve(this.#keys.get(deviceId));
  }
}

interface PendingStep {
  deviceId: string;
  taskId: string;
  stepId: string;
  settle: (result: WorkerResult) => void;
  onProgress: (progress: { percent?: number; label?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

export interface WorkerGatewayOptions {
  registry: DeviceRegistry;
  sessions: DeviceSessionService;
  credentials: DeviceCredentialProvider;
  /** Optional: without router, gateway does not emit pub/sub events. */
  router?: EventRouter;
  now?: () => Date;
  newId?: () => string;
  /** Grace period added to step timeout before Core aborts. */
  dispatchGraceMs?: number;
}

export class WorkerGateway implements WorkerTransport {
  readonly #registry: DeviceRegistry;
  readonly #sessions: DeviceSessionService;
  readonly #credentials: DeviceCredentialProvider;
  readonly #router: EventRouter | undefined;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #graceMs: number;

  readonly #connections = new Map<string, WorkerConnection>();
  readonly #pending = new Map<string, PendingStep>();

  /**
   * Authenticated connections: `connectionId` -> `deviceId`.
   *
   * Authoritative mapping of authenticated sockets. Referenced after handshake;
   * unauthenticated `connection.deviceId` is never trusted for authorization.
   */
  readonly #authenticated = new Map<string, string>();

  /** Tracked challenge requests per connection. See `MAX_HELLO_PER_CONNECTION`. */
  readonly #helloCount = new Map<string, number>();

  constructor(options: WorkerGatewayOptions) {
    this.#registry = options.registry;
    this.#sessions = options.sessions;
    this.#credentials = options.credentials;
    this.#router = options.router;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? uuidv7;
    this.#graceMs = options.dispatchGraceMs ?? 5_000;
  }

  // ── Handshake ──────────────────────────────────────────────────────────

  /**
   * Handles an incoming message frame from a worker channel.
   *
   * Single entry point for transport adapters. Unreadable frames or unrecognized
   * message types are dropped safely to prevent protocol drift crashes.
   */
  async handleMessage(connection: WorkerConnection, raw: unknown): Promise<void> {
    const message = parseWorkerMessage(raw);
    if (message === undefined) return;

    switch (message.type) {
      case WORKER_MESSAGE.hello:
        await this.#onHello(connection, message.payload as WorkerPayload<"worker.hello">);
        return;
      case WORKER_MESSAGE.authenticate:
        await this.#onAuthenticate(
          connection,
          message.payload as WorkerPayload<"worker.authenticate">,
        );
        return;
      case WORKER_MESSAGE.register:
        await this.#onRegister(connection, message.payload as WorkerPayload<"worker.register">);
        return;
      case WORKER_MESSAGE.heartbeat:
        await this.#onHeartbeat(connection, message.payload as WorkerPayload<"worker.heartbeat">);
        return;
      case WORKER_MESSAGE.taskProgress:
        this.#onProgress(connection, message.payload as WorkerPayload<"worker.task_progress">);
        return;
      case WORKER_MESSAGE.taskResult:
        await this.#onResult(connection, message.payload as WorkerPayload<"worker.task_result">);
        return;
      default:
        return;
    }
  }

  async #onHello(connection: WorkerConnection, payload: WorkerPayload<"worker.hello">) {
    // Each challenge allocates a nonce retained for one minute. Capping requests per connection
    // prevents memory exhaustion from unauthenticated clients.
    const seen = (this.#helloCount.get(connection.connectionId) ?? 0) + 1;
    this.#helloCount.set(connection.connectionId, seen);

    if (seen > MAX_HELLO_PER_CONNECTION) {
      throw new DeviceAuthenticationError(
        payload.deviceId,
        "too many challenges requested on the same connection",
      );
    }

    // A `deviceId` claim is public and untrusted. Reply with a signed challenge nonce.
    const challenge = await this.#sessions.createChallenge(payload.deviceId);
    await this.#send(connection, WORKER_MESSAGE.challenge, {
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt.toISOString(),
    });
  }

  async #onAuthenticate(
    connection: WorkerConnection,
    payload: WorkerPayload<"worker.authenticate">,
  ) {
    this.#sessions.assertNotReplayed(payload.requestId, new Date(payload.timestamp));

    const publicKey = await this.#credentials.publicKeyFor(payload.deviceId);
    if (publicKey === undefined) {
      throw new DeviceAuthenticationError(payload.deviceId, "no public key registered");
    }

    const { session, token } = await this.#sessions.authenticate(
      {
        deviceId: payload.deviceId,
        nonce: payload.nonce,
        signature: payload.signature,
        capabilities: payload.capabilities,
        ...(connection.remoteAddress === undefined
          ? {}
          : { remoteAddress: connection.remoteAddress }),
      },
      publicKey,
    );

    // Register authenticated association
    this.#authenticated.set(connection.connectionId, session.deviceId);
    this.#connections.set(session.deviceId, connection);

    // Tokens pass through only once; never logged or broadcasted in event streams
    await this.#send(connection, WORKER_MESSAGE.session, {
      sessionId: session.id,
      token,
      expiresAt: session.expiresAt.toISOString(),
      capabilities: session.capabilities,
    });

    const device = await this.#registry.requireDevice(payload.deviceId);
    await this.#emit("worker.connected", device.userId, {
      deviceId: device.id,
      deviceName: device.name,
      workerVersion: device.agentVersion ?? "unknown",
    });
  }

  /**
   * Registers declared capabilities.
   *
   * The worker is authoritative on what it can execute; the Core is authoritative
   * on what it is permitted to execute. Declared capabilities without user permissions
   * are registered here and rejected during task authorization.
   */
  async #onRegister(connection: WorkerConnection, payload: WorkerPayload<"worker.register">) {
    const deviceId = this.#requireAuthenticated(connection);
    const accepted: string[] = [];
    const rejected: { name: string; reason: string }[] = [];
    const capabilities: DeviceCapability[] = [];

    for (const declared of payload.capabilities) {
      const parsed = deviceCapabilitySchema.safeParse(declared);
      if (!parsed.success) {
        rejected.push({ name: declared.name, reason: "invalid capability definition" });
        continue;
      }
      capabilities.push(parsed.data);
      accepted.push(parsed.data.name);
    }

    // Capture previous state before updating to avoid duplicate event emissions
    const previous = ((await this.#registry.getDevice(deviceId))?.capabilities ?? [])
      .map((capability) => capability.name)
      .sort();

    await this.#registry.updateCapabilities(deviceId, capabilities);
    await this.#registry.updateHealth(deviceId, toDeviceHealth(payload.health));

    await this.#send(connection, WORKER_MESSAGE.registered, {
      accepted: accepted.sort(),
      rejected,
    });

    const device = await this.#registry.requireDevice(deviceId);
    const current = accepted.sort();

    await this.#emit("worker.ready", device.userId, {
      deviceId: device.id,
      capabilities: current,
      maxConcurrentTasks: device.health.maxConcurrentTasks,
    });

    // Notify clients if advertised capabilities changed dynamically
    if (previous.join("|") !== current.join("|")) {
      await this.#emit("device.capabilities_changed", device.userId, {
        deviceId: device.id,
        capabilities: current,
      });
    }
  }

  async #onHeartbeat(connection: WorkerConnection, payload: WorkerPayload<"worker.heartbeat">) {
    const deviceId = this.#requireAuthenticated(connection);
    this.#sessions.assertNotReplayed(payload.requestId, new Date(payload.timestamp));
    await this.#registry.updateHeartbeat(deviceId, toDeviceHealth(payload.health));

    await this.#send(connection, WORKER_MESSAGE.heartbeatAck, {
      at: this.#now().toISOString(),
      rotateSession: false,
    });
  }

  // ── Connection Management ────────────────────────────────────────────────

  isConnected(deviceId: string): boolean {
    return this.#connections.has(deviceId);
  }

  get connectedDeviceIds(): string[] {
    return [...this.#connections.keys()];
  }

  /**
   * Transport-level connection detachment.
   *
   * Only triggers offline marking and step failover if the connection was authenticated
   * and matches the currently active socket for the device.
   */
  async detachConnection(connectionId: string, reason: string): Promise<void> {
    this.#helloCount.delete(connectionId);

    const deviceId = this.#authenticated.get(connectionId);
    if (deviceId === undefined) return;

    this.#authenticated.delete(connectionId);

    // Prevent disconnecting newer superseded connection
    if (this.#connections.get(deviceId)?.connectionId !== connectionId) return;

    await this.detach(deviceId, reason);
  }

  /** Authenticated device ID for this socket connection, if any. */
  authenticatedDeviceId(connectionId: string): string | undefined {
    return this.#authenticated.get(connectionId);
  }

  async detach(deviceId: string, reason: string): Promise<void> {
    const connection = this.#connections.get(deviceId);
    if (connection !== undefined) this.#authenticated.delete(connection.connectionId);
    this.#connections.delete(deviceId);

    const orphaned = [...this.#pending.values()].filter((p) => p.deviceId === deviceId);
    for (const pending of orphaned) {
      pending.cleanup();
      pending.settle({
        ok: false,
        error: {
          code: "WORKER_DISCONNECTED",
          message: `Worker disconnected (${reason}).`,
          retryable: true,
        },
      });
    }

    const device = await this.#registry.getDevice(deviceId);
    await this.#registry.markOffline(deviceId);
    await this.#sessions.revokeAllForDevice(deviceId);

    if (device !== undefined) {
      await this.#emit("worker.disconnected", device.userId, {
        deviceId,
        reason,
        inFlightSteps: orphaned.length,
      });
    }
  }

  // ── WorkerTransport ─────────────────────────────────────────────────────

  /**
   * Dispatches a step execution order to a connected worker and awaits resolution.
   *
   * Handled paths: worker response, timeout expiration, or coordinator cancellation.
   */
  dispatch(input: WorkerDispatch): Promise<WorkerResult> {
    const connection = this.#connections.get(input.deviceId);
    if (connection === undefined) {
      return Promise.resolve({
        ok: false,
        error: {
          code: "WORKER_UNAVAILABLE",
          message: "Worker is not connected.",
          retryable: true,
        },
      });
    }

    const key = stepKey(input.taskId, input.stepId);
    if (this.#pending.has(key)) {
      return Promise.resolve({
        ok: false,
        error: {
          code: "STEP_ALREADY_RUNNING",
          message: "This step is already running on a worker.",
          retryable: false,
        },
      });
    }

    return new Promise<WorkerResult>((resolve) => {
      let settled = false;
      const settle = (result: WorkerResult) => {
        if (settled) return;
        settled = true;
        this.#pending.delete(key);
        resolve(result);
      };

      const onAbort = () => {
        void this.cancel(input.deviceId, input.taskId, input.stepId);
        cleanup();
        settle({
          ok: false,
          error: { code: "STEP_CANCELLED", message: "Step cancelled.", retryable: false },
        });
      };

      const timer = setTimeout(() => {
        void this.cancel(input.deviceId, input.taskId, input.stepId);
        cleanup();
        settle({
          ok: false,
          error: {
            code: "STEP_TIMEOUT",
            message: "Worker did not respond within allotted timeout.",
            retryable: true,
          },
        });
      }, input.timeoutMs + this.#graceMs);

      const cleanup = () => {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", onAbort);
      };

      input.signal.addEventListener("abort", onAbort, { once: true });

      this.#pending.set(key, {
        deviceId: input.deviceId,
        taskId: input.taskId,
        stepId: input.stepId,
        settle,
        onProgress: input.onProgress,
        timer,
        cleanup,
      });

      void this.#send(connection, WORKER_MESSAGE.taskDispatch, {
        taskId: input.taskId,
        stepId: input.stepId,
        capability: input.capability,
        tool: input.tool,
        arguments: input.arguments,
        timeoutMs: input.timeoutMs,
        riskLevel: "MEDIUM",
        requestId: this.#newId(),
      }).catch(() => {
        cleanup();
        settle({
          ok: false,
          error: {
            code: "WORKER_UNREACHABLE",
            message: "Command could not be transmitted.",
            retryable: true,
          },
        });
      });
    });
  }

  async cancel(deviceId: string, taskId: string, stepId: string): Promise<void> {
    const connection = this.#connections.get(deviceId);
    if (connection === undefined) return;

    await this.#send(connection, WORKER_MESSAGE.taskCancel, {
      taskId,
      stepId,
      reason: "cancelled by NEXUS",
    }).catch(() => undefined);

    const device = await this.#registry.getDevice(deviceId);
    if (device !== undefined) {
      await this.#emit("worker.task_cancelled", device.userId, {
        taskId,
        stepId,
        deviceId,
        reason: "cancelled by NEXUS",
      });
    }
  }

  // ── Worker Responses ────────────────────────────────────────────────────

  #onProgress(connection: WorkerConnection, payload: WorkerPayload<"worker.task_progress">): void {
    const deviceId = this.#requireAuthenticated(connection);
    const pending = this.#pending.get(stepKey(payload.taskId, payload.stepId));
    if (pending === undefined) return;

    this.#assertOwnsStep(pending, deviceId, payload.taskId, payload.stepId);

    pending.onProgress({
      ...(payload.percent === null ? {} : { percent: payload.percent }),
      ...(payload.label === null ? {} : { label: payload.label }),
    });
  }

  #onResult(
    connection: WorkerConnection,
    payload: WorkerPayload<"worker.task_result">,
  ): Promise<void> {
    const deviceId = this.#requireAuthenticated(connection);
    const key = stepKey(payload.taskId, payload.stepId);
    const pending = this.#pending.get(key);
    // Late results after timeout expiration are discarded safely
    if (pending === undefined) return Promise.resolve();

    this.#assertOwnsStep(pending, deviceId, payload.taskId, payload.stepId);

    pending.cleanup();
    pending.settle(
      payload.ok
        ? { ok: true, result: payload.result, sensitiveResult: payload.sensitiveResult }
        : {
            ok: false,
            error: payload.error ?? {
              code: "WORKER_ERROR",
              message: "Failure without details.",
              retryable: false,
            },
          },
    );
    return Promise.resolve();
  }

  // ── Guards ──────────────────────────────────────────────────────────────

  #requireAuthenticated(connection: WorkerConnection): string {
    const deviceId = this.#authenticated.get(connection.connectionId);
    if (deviceId === undefined) {
      throw new DeviceAuthenticationError(
        connection.deviceId,
        "frame received on unauthenticated connection",
      );
    }
    return deviceId;
  }

  #assertOwnsStep(pending: PendingStep, deviceId: string, taskId: string, stepId: string): void {
    if (pending.deviceId === deviceId) return;

    throw new DeviceAuthenticationError(
      deviceId,
      "response for a step assigned to another worker",
      { taskId, stepId, dispatchedTo: pending.deviceId },
    );
  }

  // ── Internal ────────────────────────────────────────────────────────────

  async #send<T extends WorkerMessageType>(
    connection: WorkerConnection,
    type: T,
    payload: WorkerPayload<T>,
  ): Promise<void> {
    await connection.send(workerEnvelope(type, payload, { id: this.#newId(), at: this.#now() }));
  }

  async #emit(
    type:
      | "worker.connected"
      | "worker.ready"
      | "worker.disconnected"
      | "worker.task_cancelled"
      | "device.capabilities_changed",
    userId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (this.#router === undefined) return;
    await this.#router.emit({
      type,
      userId,
      correlationId: this.#newId(),
      originClientDeviceId: null,
      payload,
    });
  }
}

function stepKey(taskId: string, stepId: string): string {
  return `${taskId}:${stepId}`;
}

/** Converts worker health report to device model health format. */
function toDeviceHealth(health: WorkerHealth): Partial<DeviceHealth> {
  return {
    ...(health.cpuLoad === undefined ? {} : { cpuLoad: health.cpuLoad }),
    ...(health.memoryFreeMb === undefined ? {} : { memoryFreeMb: health.memoryFreeMb }),
    ...(health.diskFreeMb === undefined ? {} : { diskFreeMb: health.diskFreeMb }),
    ...(health.batteryPercent === undefined ? {} : { batteryPercent: health.batteryPercent }),
    ...(health.onBattery === undefined ? {} : { onBattery: health.onBattery }),
    activeTasks: health.activeTasks,
    maxConcurrentTasks: health.maxConcurrentTasks,
  };
}
