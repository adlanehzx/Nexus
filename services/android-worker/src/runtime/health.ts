import type { WorkerHealth } from "@nexus/protocol";
import type { HealthSource } from "@nexus/worker-core";
import type { AndroidBatteryState, AndroidDeviceInspector } from "../ports.js";

/**
 * Phone health.
 */

/** Below this level and discharging, the device reports degraded. */
export const DEFAULT_LOW_BATTERY_PERCENT = 20;

/** Below this level, it rejects new tasks. */
export const DEFAULT_CRITICAL_BATTERY_PERCENT = 10;

export interface AndroidHealthSourceOptions {
  device: AndroidDeviceInspector;
  maxConcurrentTasks: number;
  activeTasks: () => number;
  lowBatteryPercent?: number;
  criticalBatteryPercent?: number;
}

export class AndroidHealthSource implements HealthSource {
  readonly #device: AndroidDeviceInspector;
  readonly #maxConcurrent: number;
  readonly #activeTasks: () => number;
  readonly #low: number;
  readonly #critical: number;

  #battery: AndroidBatteryState = { percent: 100, charging: true, powerSaveMode: false };

  constructor(options: AndroidHealthSourceOptions) {
    this.#device = options.device;
    this.#maxConcurrent = options.maxConcurrentTasks;
    this.#activeTasks = options.activeTasks;
    this.#low = options.lowBatteryPercent ?? DEFAULT_LOW_BATTERY_PERCENT;
    this.#critical = options.criticalBatteryPercent ?? DEFAULT_CRITICAL_BATTERY_PERCENT;
  }

  /** Refreshes battery state before each heartbeat. */
  async refresh(): Promise<void> {
    try {
      this.#battery = await this.#device.batteryState();
    } catch {
      // Failing read does not fail the heartbeat.
    }
  }

  get battery(): AndroidBatteryState {
    return this.#battery;
  }

  snapshot(): WorkerHealth {
    return {
      batteryPercent: this.#battery.percent,
      onBattery: !this.#battery.charging,
      activeTasks: this.#activeTasks(),
      maxConcurrentTasks: this.isDegraded() ? 1 : this.#maxConcurrent,
    };
  }

  hasCapacity(): boolean {
    if (!this.#battery.charging && this.#battery.percent <= this.#critical) return false;

    return this.#activeTasks() < (this.isDegraded() ? 1 : this.#maxConcurrent);
  }

  isDegraded(): boolean {
    if (this.#battery.charging) return false;
    return this.#battery.percent <= this.#low || this.#battery.powerSaveMode;
  }
}
