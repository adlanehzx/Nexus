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
 * L'exécutant navigateur.
 *
 * Une **composition**, pas une implémentation. Le cycle de vie — poignée de
 * main, signature du défi, enregistrement des capacités, battements, dispatch,
 * annulation, reprise — vit dans `WorkerRuntime` de `@nexus/worker-core`,
 * exactement le même que le worker Windows et le worker Android. Le protocole
 * est le même, l'authentification est la même, le registre est le même.
 *
 * Ce fichier n'ajoute que ce qui est propre à Browser Use :
 *
 *  - une **santé** qui décrit le worker Python, pas la machine ;
 *  - le **ménage des sessions** : un Chromium laissé ouvert survit à l'arrêt.
 *
 * `browser-use` n'apparaît nulle part : il vit derrière un contrat HTTP, dans
 * un processus séparé (ADR-006).
 */

export const WORKER_VERSION = "0.1.0";

/**
 * Plateforme annoncée au cœur.
 *
 * `WEB`, comme `devicePlatformSchema` de `@nexus/devices` : cet exécutant n'a
 * pas de système d'exploitation propre du point de vue de NEXUS. Le type
 * d'appareil, lui, est `BROWSER_WORKER`, et il est fixé au registre — pas ici.
 * Un worker qui déciderait de son propre type pourrait s'élargir.
 */
export const WORKER_PLATFORM = "WEB";

export interface BrowserWorkerHostOptions {
  config: BrowserHostConfig;
  capabilities: LocalCapabilityRegistry;
  /** Client du worker Python. Sert ici uniquement a lire sa sante. */
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

/** Traduit la configuration de l'hôte vers ce que le runtime commun attend. */
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
        // Renseigne apres la construction du runtime : la sante et le runtime
        // se referencent mutuellement, et une fonction rompt le cycle.
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
   * Démarre l'exécutant.
   *
   * La santé est lue **avant** la connexion : le worker doit savoir si le
   * navigateur répond avant de s'annoncer. Annoncer `browser.navigate` puis
   * découvrir que le worker Python est éteint ferait échouer une tâche après
   * avoir écarté un exécutant capable.
   */
  async start(): Promise<void> {
    await this.health.refresh();
    await this.runtime.start();

    this.#logger.info("exécutant navigateur démarré", this.health.describe());
  }

  /**
   * Arrête l'exécutant, et ferme les navigateurs.
   *
   * L'ordre compte : on arrête d'abord le runtime, qui annule les tâches en
   * cours et remonte leurs échecs au cœur, puis on ferme les sessions. Fermer
   * d'abord laisserait des étapes se terminer sur une session disparue.
   */
  async stop(reason = "arrêt demandé"): Promise<void> {
    await this.runtime.stop(reason);
    await this.#sessions.releaseAll();
  }

  /** Diagnostic destiné aux journaux. Ne contient ni secret ni contenu de page. */
  describe(): Record<string, unknown> {
    return {
      ...this.runtime.describe(),
      platform: WORKER_PLATFORM,
      browser: this.health.describe(),
      openSessions: this.#sessions.openSessions,
    };
  }
}
