import {
  WorkerRuntime,
  type CredentialSigner,
  type LocalCapabilityRegistry,
  type TimerPort,
  type WorkerLink,
  type WorkerLogger,
  type WorkerRuntimeConfig,
} from "@nexus/worker-core";
import type { BrowserWorkerClient } from "@nexus/browser-client";
import type { BrowserHostConfig } from "./config.js";
import { BrowserHealthSource } from "./runtime/health.js";
import type { SessionPool } from "./runtime/session-pool.js";

/**
 * Browser worker host.
 *
 * Coordinates `@nexus/worker-core` runtime with browser-use via HTTP client.
 */

export const WORKER_VERSION = "0.1.0";
export const WORKER_PLATFORM = "WEB";

export interface BrowserWorkerHostOptions {
  config: BrowserHostConfig;
  capabilities: LocalCapabilityRegistry;
  client: BrowserWorkerClient;
  sessions: SessionPool;
  link: WorkerLink;
  signer: CredentialSigner;
  logger: WorkerLogger;
  health?: BrowserHealthSource;
  now?: () => Date;
  newId?: () => string;
  timers?: TimerPort;
  random?: () => number;
}

/** Translate host config into generic worker runtime config. */
export function toRuntimeConfig(config: BrowserHostConfig): WorkerRuntimeConfig {
  return {
    deviceId: config.deviceId,
    platform: WORKER_PLATFORM,
    workerVersion: WORKER_VERSION,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    taskTimeoutMs: config.taskTimeoutMs,
    maxConcurrentTasks: config.maxConcurrentTasks,
    reconnectMinMs: config.reconnectMinMs,
    reconnectMaxMs: config.reconnectMaxMs,
  };
}

export class BrowserWorkerHost {
  readonly runtime: WorkerRuntime;
  readonly health: BrowserHealthSource;

  readonly #sessions: SessionPool;
  readonly #logger: WorkerLogger;

  constructor(options: BrowserWorkerHostOptions) {
    this.#sessions = options.sessions;
    this.#logger = options.logger.child({ platform: WORKER_PLATFORM });

    this.health =
      options.health ??
      new BrowserHealthSource({
        client: options.client,
        maxConcurrentTasks: options.config.maxConcurrentTasks,
        activeTasks: () => this.runtime.activeTaskCount,
      });

    this.runtime = new WorkerRuntime({
      config: toRuntimeConfig(options.config),
      link: options.link,
      signer: options.signer,
      capabilities: options.capabilities,
      logger: options.logger,
      health: this.health,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.newId === undefined ? {} : { newId: options.newId }),
      ...(options.timers === undefined ? {} : { timers: options.timers }),
      ...(options.random === undefined ? {} : { random: options.random }),
    });
  }

  get state() {
    return this.runtime.state;
  }

  get isAuthenticated(): boolean {
    return this.runtime.isAuthenticated;
  }

  get activeTaskCount(): number {
    return this.runtime.activeTaskCount;
  }

  /**
   * Start host daemon.
   */
  async start(): Promise<void> {
    await this.health.refresh();
    await this.runtime.start();

    this.#logger.info("browser worker host started", this.health.describe());
  }

  /**
   * Stop host daemon and clean up all open browser sessions.
   */
  async stop(reason = "shutdown requested"): Promise<void> {
    await this.runtime.stop(reason);
    await this.#sessions.releaseAll();
  }

  /** Safe diagnostic status for logging. */
  describe(): Record<string, unknown> {
    return {
      ...this.runtime.describe(),
      platform: WORKER_PLATFORM,
      browser: this.health.describe(),
      openSessions: this.#sessions.openSessions,
    };
  }
}
