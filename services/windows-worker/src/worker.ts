import {
  WorkerRuntime,
  type CredentialSigner,
  type HealthSource,
  type LocalCapabilityRegistry,
  type TimerPort,
  type WorkerLink,
  type WorkerLogger,
  type WorkerRuntimeConfig,
} from "@nexus/worker-core";
import type { WorkerConfig } from "./config.js";
import { NodeHealthSource } from "./runtime/health.js";

/**
 * Windows worker daemon.
 *
 * A **composition**, not an implementation: the complete lifecycle — handshake,
 * registration, heartbeats, task execution, reconnection — lives in `WorkerRuntime`
 * within `@nexus/worker-core`, shared with the Android worker.
 *
 * This file adds only what is specific to Windows: declared platform, version,
 * and a health source reading `node:os`.
 */

export const WORKER_VERSION = "0.1.0";
export const WORKER_PLATFORM = "WINDOWS";

export interface WindowsWorkerOptions {
  config: WorkerConfig;
  link: WorkerLink;
  signer: CredentialSigner;
  capabilities: LocalCapabilityRegistry;
  logger: WorkerLogger;
  health?: HealthSource;
  now?: () => Date;
  newId?: () => string;
  timers?: TimerPort;
  random?: () => number;
}

/** Translates Windows worker configuration to common runtime config. */
export function toRuntimeConfig(config: WorkerConfig): WorkerRuntimeConfig {
  return {
    deviceId: config.deviceId,
    platform: config.platform ?? WORKER_PLATFORM,
    workerVersion: WORKER_VERSION,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    taskTimeoutMs: config.taskTimeoutMs,
    maxConcurrentTasks: config.maxConcurrentTasks,
    reconnectMinMs: config.reconnectMinMs,
    reconnectMaxMs: config.reconnectMaxMs,
  };
}

export function createWindowsWorker(options: WindowsWorkerOptions): WorkerRuntime {
  const holder: { runtime?: WorkerRuntime } = {};

  const health =
    options.health ??
    new NodeHealthSource({
      maxConcurrentTasks: options.config.maxConcurrentTasks,
      activeTasks: () => holder.runtime?.activeTaskCount ?? 0,
    });

  const runtime = new WorkerRuntime({
    config: toRuntimeConfig(options.config),
    link: options.link,
    signer: options.signer,
    capabilities: options.capabilities,
    logger: options.logger,
    health,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.newId === undefined ? {} : { newId: options.newId }),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    ...(options.random === undefined ? {} : { random: options.random }),
  });

  holder.runtime = runtime;
  return runtime;
}

export { WorkerRuntime as WindowsWorker };
