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
 * Le worker Windows.
 *
 * Une **composition**, pas une implémentation : tout le cycle de vie — poignée
 * de main, enregistrement, battements de cœur, exécution, reprise — vit dans
 * `WorkerRuntime` de `@nexus/worker-core`, partagé avec le worker Android.
 *
 * Ce fichier n'ajoute que ce qui est propre à Windows : la plateforme annoncée,
 * la version, et une source de santé qui lit `node:os`.
 *
 * **Rien ici ne sait s'il tourne sur le portable ou sur le poste fixe.** Le nom
 * de la machine, son rôle et ses permissions viennent de la configuration et du
 * registre côté cœur.
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

/** Traduit la configuration Windows vers ce que le runtime commun attend. */
export function toRuntimeConfig(config: WorkerConfig): WorkerRuntimeConfig {
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

export function createWindowsWorker(options: WindowsWorkerOptions): WorkerRuntime {
  // La santé lit le nombre de tâches actives du runtime, que le runtime exige à
  // sa construction. Ce porteur rompt le cycle sans rendre la référence mutable
  // au-delà de l'assemblage.
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
