import {
  WorkerRuntime,
  systemTimers,
  type CredentialSigner,
  type LocalCapabilityRegistry,
  type TimerPort,
  type WorkerLink,
  type WorkerLogger,
  type WorkerRuntimeConfig,
} from "@nexus/worker-core";
import type { AndroidWorkerConfig } from "./config.js";
import type { AndroidPlatform } from "./ports.js";
import { AndroidHealthSource } from "./runtime/health.js";
import { AvailabilityWatcher, type AvailabilitySnapshot } from "./runtime/availability.js";

/**
 * Android worker.
 */

export const WORKER_VERSION = "0.1.0";
export const WORKER_PLATFORM = "ANDROID";

export interface AndroidWorkerOptions {
  config: AndroidWorkerConfig;
  platform: AndroidPlatform;
  capabilities: LocalCapabilityRegistry;
  link: WorkerLink;
  signer: CredentialSigner;
  logger: WorkerLogger;
  now?: () => Date;
  newId?: () => string;
  timers?: TimerPort;
  random?: () => number;
}

/** Translates Android configuration to common runtime config. */
export function toRuntimeConfig(config: AndroidWorkerConfig): WorkerRuntimeConfig {
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

export class AndroidWorker {
  readonly runtime: WorkerRuntime;
  readonly health: AndroidHealthSource;
  readonly availability: AvailabilityWatcher;

  readonly #config: AndroidWorkerConfig;
  readonly #logger: WorkerLogger;
  readonly #timers: TimerPort;

  #availabilityHandle: unknown;
  #stopped = false;

  constructor(options: AndroidWorkerOptions) {
    this.#config = options.config;
    this.#logger = options.logger.child({ platform: WORKER_PLATFORM });
    this.#timers = options.timers ?? systemTimers;

    this.health = new AndroidHealthSource({
      device: options.platform.device,
      maxConcurrentTasks: options.config.maxConcurrentTasks,
      activeTasks: () => this.runtime.activeTaskCount,
      lowBatteryPercent: options.config.lowBatteryPercent,
      criticalBatteryPercent: options.config.criticalBatteryPercent,
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
      timers: this.#timers,
      ...(options.random === undefined ? {} : { random: options.random }),
    });

    this.availability = new AvailabilityWatcher({
      platform: options.platform,
      logger: this.#logger,
      onChange: (snapshot) => this.#onAvailabilityChange(snapshot),
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

  async start(): Promise<void> {
    this.#stopped = false;
    await this.health.refresh();
    await this.availability.prime();

    await this.runtime.start();
    this.#scheduleAvailabilityCheck();
  }

  async stop(reason = "requested stop"): Promise<void> {
    this.#stopped = true;

    if (this.#availabilityHandle !== undefined) {
      this.#timers.clear(this.#availabilityHandle);
      this.#availabilityHandle = undefined;
    }

    await this.runtime.stop(reason);
  }

  /** Diagnostics for management screen. Contains no secrets. */
  describe(): Record<string, unknown> {
    return {
      ...this.runtime.describe(),
      platform: WORKER_PLATFORM,
      battery: this.health.battery,
      degraded: this.health.isDegraded(),
      availability: this.availability.last ?? null,
    };
  }

  async #onAvailabilityChange(snapshot: AvailabilitySnapshot): Promise<void> {
    await this.health.refresh();
    const announced = await this.runtime.announceCapabilities();

    this.#logger.info("capabilities re-announced", {
      announced,
      accessibility: snapshot.accessibility,
      screenshot: snapshot.screenshot,
      notifications: snapshot.notifications,
    });
  }

  #scheduleAvailabilityCheck(): void {
    const tick = () => {
      if (this.#stopped) return;

      void (async () => {
        await this.health.refresh();
        await this.availability.check();
      })()
        .catch(() => undefined)
        .finally(() => {
          if (!this.#stopped) {
            this.#availabilityHandle = this.#timers.set(tick, this.#config.availabilityIntervalMs);
          }
        });
    };

    this.#availabilityHandle = this.#timers.set(tick, this.#config.availabilityIntervalMs);
  }
}
