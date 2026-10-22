import os from "node:os";
import type { WorkerHealth } from "@nexus/protocol";
import type { HealthSource } from "@nexus/worker-core";

/**
 * Local health reporting.
 */

export interface NodeHealthSourceOptions {
  maxConcurrentTasks: number;
  activeTasks: () => number;
  loadAverage?: () => number;
  freeMemoryMb?: () => number;
}

export class NodeHealthSource implements HealthSource {
  readonly #maxConcurrent: number;
  readonly #activeTasks: () => number;
  readonly #load: () => number;
  readonly #freeMemory: () => number;

  constructor(options: NodeHealthSourceOptions) {
    this.#maxConcurrent = options.maxConcurrentTasks;
    this.#activeTasks = options.activeTasks;
    this.#load = options.loadAverage ?? defaultLoad;
    this.#freeMemory = options.freeMemoryMb ?? (() => Math.round(os.freemem() / (1024 * 1024)));
  }

  snapshot(): WorkerHealth {
    return {
      cpuLoad: clamp01(this.#load()),
      memoryFreeMb: Math.max(0, Math.round(this.#freeMemory())),
      activeTasks: this.#activeTasks(),
      maxConcurrentTasks: this.#maxConcurrent,
    };
  }

  hasCapacity(): boolean {
    return this.#activeTasks() < this.#maxConcurrent;
  }

  isDegraded(): boolean {
    return false;
  }
}

function defaultLoad(): number {
  const cpus = os.cpus();
  if (cpus.length === 0) return 0;

  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }

  return total === 0 ? 0 : 1 - idle / total;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
