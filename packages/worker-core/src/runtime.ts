import { uuidv7 } from "@nexus/shared";
import {
  WORKER_MESSAGE,
  parseWorkerMessage,
  workerEnvelope,
  type WorkerMessageType,
  type WorkerPayload,
} from "@nexus/protocol";
import type { WorkerLogger } from "./logging.js";
import type { LocalCapabilityRegistry } from "./capabilities.js";
import type { CredentialSigner, HealthSource, TimerPort } from "./ports.js";
import { systemTimers } from "./ports.js";
import type { WorkerLink } from "./link.js";
import { Backoff } from "./backoff.js";
import { TaskRunner } from "./task-runner.js";
import { WorkerNotAuthenticatedError } from "./errors.js";

/**
 * Platform-independent worker runtime.
 *
 * Runs across Windows, Linux, macOS, and Android nodes without platform-specific assumptions.
 *
 * Lifecycle:
 *   start -> connect -> hello -> challenge -> authenticate -> session
 *   -> register -> heartbeat <-> receive/execute -> shutdown
 */

export type WorkerState =
  | "stopped"
  | "connecting"
  | "authenticating"
  | "registering"
  | "ready"
  | "reconnecting"
  | "stopping";

export interface WorkerRuntimeConfig {
  deviceId: string;
  /** `WINDOWS`, `ANDROID`, `LINUX`, etc. Included in hello handshake. */
  platform: string;
  workerVersion: string;
  heartbeatIntervalMs: number;
  taskTimeoutMs: number;
  maxConcurrentTasks: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
}

export interface WorkerRuntimeOptions {
  config: WorkerRuntimeConfig;
  link: WorkerLink;
  signer: CredentialSigner;
  capabilities: LocalCapabilityRegistry;
  logger: WorkerLogger;
  health: HealthSource;
  now?: () => Date;
  newId?: () => string;
  timers?: TimerPort;
  random?: () => number;
}

export class WorkerRuntime {
  readonly #config: WorkerRuntimeConfig;
  readonly #link: WorkerLink;
  readonly #signer: CredentialSigner;
  readonly #capabilities: LocalCapabilityRegistry;
  readonly #logger: WorkerLogger;
  readonly #health: HealthSource;
  readonly #runner: TaskRunner;
  readonly #backoff: Backoff;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;

  #state: WorkerState = "stopped";
  #sessionToken: string | undefined;
  #sessionId: string | undefined;
  #grantedCapabilities: string[] = [];
  #heartbeatHandle: unknown;
  #reconnectHandle: unknown;
  #reconnecting = false;

  constructor(options: WorkerRuntimeOptions) {
    this.#config = options.config;
    this.#link = options.link;
    this.#signer = options.signer;
    this.#capabilities = options.capabilities;
    this.#logger = options.logger.child({ deviceId: options.config.deviceId });
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? uuidv7;
    const timers = options.timers ?? systemTimers;
    this.#setTimer = (callback, delayMs) => timers.set(callback, delayMs);
    this.#clearTimer = (handle) => {
      timers.clear(handle);
    };

    this.#runner = new TaskRunner({
      capabilities: options.capabilities,
      logger: this.#logger,
      sendProgress: (payload) => this.#send(WORKER_MESSAGE.taskProgress, payload),
      sendResult: (payload) => this.#send(WORKER_MESSAGE.taskResult, payload),
      maxConcurrentTasks: options.config.maxConcurrentTasks,
      defaultTimeoutMs: options.config.taskTimeoutMs,
      now: this.#now,
    });

    this.#health = options.health;

    this.#backoff = new Backoff({
      minMs: options.config.reconnectMinMs,
      maxMs: options.config.reconnectMaxMs,
      ...(options.random === undefined ? {} : { random: options.random }),
    });

    this.#link.onMessage((envelope) => {
      void this.#onEnvelope(envelope);
    });
    this.#link.onClose((reason) => {
      this.#onClose(reason);
    });
  }

  get state(): WorkerState {
    return this.#state;
  }

  get grantedCapabilities(): readonly string[] {
    return this.#grantedCapabilities;
  }

  get activeTaskCount(): number {
    return this.#runner.activeCount;
  }

  get isAuthenticated(): boolean {
    return this.#sessionToken !== undefined;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Starts the worker and opens the connection link.
   * Runs local capability probes before connecting.
   */
  async start(): Promise<void> {
    this.#state = "connecting";
    await this.#capabilities.probeAll();

    this.#logger.info("local capabilities probed", {
      available: this.#capabilities.declare().map((capability) => capability.name),
    });

    await this.#connect();
  }

  /**
   * Graceful worker shutdown.
   */
  async stop(reason = "shutdown requested"): Promise<void> {
    this.#state = "stopping";
    this.#stopHeartbeat();

    if (this.#reconnectHandle !== undefined) {
      this.#clearTimer(this.#reconnectHandle);
      this.#reconnectHandle = undefined;
    }
    this.#reconnecting = false;

    const cancelled = this.#runner.cancelAll(reason);
    if (cancelled > 0) {
      await Promise.resolve();
    }

    await this.#link.close(reason).catch(() => undefined);
    this.#sessionToken = undefined;
    this.#sessionId = undefined;
    this.#state = "stopped";

    this.#logger.info("worker stopped", { reason, cancelledSteps: cancelled });
  }

  // ── Connection & Handshake ──────────────────────────────────────────────

  async #connect(): Promise<void> {
    try {
      await this.#link.connect();
    } catch (cause) {
      this.#logger.warn("connection failed", {
        reason: cause instanceof Error ? cause.message : "unknown",
      });
      this.#scheduleReconnect("connection failed");
      return;
    }

    this.#state = "authenticating";
    await this.#send(WORKER_MESSAGE.hello, {
      deviceId: this.#config.deviceId,
      workerVersion: this.#config.workerVersion,
      platform: this.#config.platform,
    });
  }

  async #onEnvelope(raw: unknown): Promise<void> {
    const message = parseWorkerMessage(raw);
    if (message === undefined) {
      return;
    }

    try {
      switch (message.type) {
        case WORKER_MESSAGE.challenge:
          await this.#onChallenge(message.payload as WorkerPayload<"worker.challenge">);
          return;
        case WORKER_MESSAGE.session:
          await this.#onSession(message.payload as WorkerPayload<"worker.session">);
          return;
        case WORKER_MESSAGE.registered:
          this.#onRegistered(message.payload as WorkerPayload<"worker.registered">);
          return;
        case WORKER_MESSAGE.heartbeatAck:
          this.#onHeartbeatAck(message.payload as WorkerPayload<"worker.heartbeat_ack">);
          return;
        case WORKER_MESSAGE.taskDispatch:
          await this.#onDispatch(message.payload as WorkerPayload<"worker.task_dispatch">);
          return;
        case WORKER_MESSAGE.taskCancel:
          this.#onCancel(message.payload as WorkerPayload<"worker.task_cancel">);
          return;
        default:
          return;
      }
    } catch (cause) {
      this.#logger.error("unhandled envelope", {
        type: message.type,
        reason: cause instanceof Error ? cause.message : "unknown",
      });
    }
  }

  async #onChallenge(payload: WorkerPayload<"worker.challenge">): Promise<void> {
    const signature = await this.#signer.sign(payload.nonce);

    await this.#send(WORKER_MESSAGE.authenticate, {
      deviceId: this.#config.deviceId,
      nonce: payload.nonce,
      signature,
      capabilities: this.#capabilities.declare().map((capability) => capability.name),
      requestId: this.#newId(),
      timestamp: this.#now().toISOString(),
    });
  }

  async #onSession(payload: WorkerPayload<"worker.session">): Promise<void> {
    this.#sessionToken = payload.token;
    this.#sessionId = payload.sessionId;
    this.#grantedCapabilities = [...payload.capabilities];
    this.#backoff.reset();
    this.#state = "registering";

    this.#logger.info("session established", {
      sessionId: payload.sessionId,
      grantedCapabilitiesCount: payload.capabilities.length,
    });

    await this.#send(WORKER_MESSAGE.register, {
      capabilities: this.#capabilities.declare(),
      health: this.#health.snapshot(),
    });
  }

  #onRegistered(payload: WorkerPayload<"worker.registered">): void {
    this.#state = "ready";
    this.#startHeartbeat();

    this.#grantedCapabilities = [...payload.accepted];

    this.#logger.info("worker ready", {
      accepted: payload.accepted.length,
      rejected: payload.rejected.length,
    });

    for (const rejected of payload.rejected) {
      this.#logger.warn("capability rejected by server", {
        capability: rejected.name,
        reason: rejected.reason,
      });
    }
  }

  #onHeartbeatAck(payload: WorkerPayload<"worker.heartbeat_ack">): void {
    if (!payload.rotateSession) return;

    this.#logger.info("session rotation requested");
    void this.#send(WORKER_MESSAGE.hello, {
      deviceId: this.#config.deviceId,
      workerVersion: this.#config.workerVersion,
      platform: this.#config.platform,
    });
  }

  async #onDispatch(payload: WorkerPayload<"worker.task_dispatch">): Promise<void> {
    if (this.#sessionToken === undefined) {
      this.#logger.warn("dispatch received outside active session, ignoring", {
        taskId: payload.taskId,
        stepId: payload.stepId,
      });
      throw new WorkerNotAuthenticatedError("task dispatch received prior to session establishment");
    }

    await this.#runner.handleDispatch(payload);
  }

  #onCancel(payload: WorkerPayload<"worker.task_cancel">): void {
    this.#runner.cancel(payload.taskId, payload.stepId, payload.reason);
  }

  // ── Heartbeat ───────────────────────────────────────────────────────────

  #startHeartbeat(): void {
    this.#stopHeartbeat();

    const beat = () => {
      if (this.#state !== "ready") return;

      void this.#send(WORKER_MESSAGE.heartbeat, {
        requestId: this.#newId(),
        timestamp: this.#now().toISOString(),
        health: this.#health.snapshot(),
      }).catch((cause: unknown) => {
        this.#logger.warn("heartbeat delivery failed", {
          reason: cause instanceof Error ? cause.message : "unknown",
        });
      });

      this.#heartbeatHandle = this.#setTimer(beat, this.#config.heartbeatIntervalMs);
    };

    this.#heartbeatHandle = this.#setTimer(beat, this.#config.heartbeatIntervalMs);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatHandle === undefined) return;
    this.#clearTimer(this.#heartbeatHandle);
    this.#heartbeatHandle = undefined;
  }

  /**
   * Re-announces capabilities to core server following probe updates.
   */
  async announceCapabilities(): Promise<boolean> {
    if (this.#state !== "ready") return false;

    await this.#capabilities.probeAll();
    await this.#send(WORKER_MESSAGE.register, {
      capabilities: this.#capabilities.declare(),
      health: this.#health.snapshot(),
    });
    return true;
  }

  /** Sends an immediate heartbeat telemetry message. */
  async sendHeartbeat(): Promise<void> {
    await this.#send(WORKER_MESSAGE.heartbeat, {
      requestId: this.#newId(),
      timestamp: this.#now().toISOString(),
      health: this.#health.snapshot(),
    });
  }

  // ── Reconnection ────────────────────────────────────────────────────────

  #onClose(reason: string): void {
    if (this.#state === "stopping" || this.#state === "stopped") return;

    this.#stopHeartbeat();
    this.#sessionToken = undefined;
    this.#sessionId = undefined;

    const cancelled = this.#runner.cancelAll("connection lost");

    this.#logger.warn("connection lost", { reason, cancelledSteps: cancelled });
    this.#scheduleReconnect(reason);
  }

  #scheduleReconnect(reason: string): void {
    if (this.#reconnecting) return;
    this.#reconnecting = true;
    this.#state = "reconnecting";

    const delayMs = this.#backoff.next();
    this.#logger.info("reconnect scheduled", {
      reason,
      delayMs,
      attempt: this.#backoff.attempt,
    });

    this.#reconnectHandle = this.#setTimer(() => {
      this.#reconnecting = false;
      this.#reconnectHandle = undefined;
      if (this.#state === "stopping" || this.#state === "stopped") return;
      void this.#connect();
    }, delayMs);
  }

  // ── Messaging ───────────────────────────────────────────────────────────

  async #send<T extends WorkerMessageType>(type: T, payload: WorkerPayload<T>): Promise<void> {
    await this.#link.send(workerEnvelope(type, payload, { id: this.#newId(), at: this.#now() }));
  }

  /** Snapshot of internal worker state for diagnostics. */
  describe(): Record<string, unknown> {
    return {
      state: this.#state,
      sessionId: this.#sessionId ?? null,
      authenticated: this.isAuthenticated,
      activeTasks: this.#runner.activeCount,
      grantedCapabilities: this.#grantedCapabilities,
      health: this.#health.snapshot(),
    };
  }
}
