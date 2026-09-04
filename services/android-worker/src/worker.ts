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
 * Le worker Android.
 *
 * Une **composition**, pas une implémentation : le cycle de vie — poignée de
 * main, enregistrement, battements de cœur, exécution, reprise — vit dans
 * `WorkerRuntime` de `@nexus/worker-core`, partagé avec le worker Windows. Le
 * protocole est le même, l'authentification est la même, le registre de
 * capacités est le même.
 *
 * Ce fichier n'ajoute que ce qui est propre à un téléphone :
 *
 *  - la **santé de batterie**, qui peut faire passer l'appareil en dégradé ;
 *  - la **surveillance de disponibilité**, parce que sur Android les capacités
 *    apparaissent et disparaissent au gré des réglages de l'utilisateur.
 *
 * Le Redmi Note 10S n'apparaît nulle part : c'est une ligne en base, de type
 * `ANDROID` et de rôle `WORKER`.
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

/** Traduit la configuration Android vers ce que le runtime commun attend. */
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

/**
 * Worker Android assemblé.
 *
 * Expose le runtime commun et les deux boucles propres au téléphone. Elles sont
 * démarrées explicitement plutôt qu'au constructeur : un objet qui déclenche des
 * minuteries à sa création est impossible à instancier dans un test sans effets.
 */
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
      // Renseigné après la construction du runtime : la santé et le runtime se
      // référencent mutuellement, et une fonction rompt le cycle.
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

  /**
   * Démarre le worker.
   *
   * La batterie et la disponibilité sont lues **avant** la connexion : le worker
   * doit savoir ce qu'il sait faire avant de l'annoncer. Annoncer
   * `android.ui.click` puis découvrir que le service d'accessibilité est
   * désactivé ferait échouer une tâche après avoir écarté un exécutant capable.
   */
  async start(): Promise<void> {
    this.#stopped = false;
    await this.health.refresh();
    await this.availability.prime();

    await this.runtime.start();
    this.#scheduleAvailabilityCheck();
  }

  async stop(reason = "arrêt demandé"): Promise<void> {
    this.#stopped = true;

    if (this.#availabilityHandle !== undefined) {
      this.#timers.clear(this.#availabilityHandle);
      this.#availabilityHandle = undefined;
    }

    await this.runtime.stop(reason);
  }

  /** Diagnostic destiné à l'écran de gestion. Ne contient aucun secret. */
  describe(): Record<string, unknown> {
    return {
      ...this.runtime.describe(),
      platform: WORKER_PLATFORM,
      battery: this.health.battery,
      degraded: this.health.isDegraded(),
      availability: this.availability.last ?? null,
    };
  }

  /**
   * Une capacité vient d'apparaître ou de disparaître.
   *
   * La santé est relue au passage : l'utilisateur qui vient de brancher son
   * téléphone doit cesser d'être vu comme dégradé sans attendre le battement
   * suivant.
   */
  async #onAvailabilityChange(snapshot: AvailabilitySnapshot): Promise<void> {
    await this.health.refresh();
    const announced = await this.runtime.announceCapabilities();

    this.#logger.info("capacités réannoncées", {
      annoncé: announced,
      accessibilité: snapshot.accessibility,
      capture: snapshot.screenshot,
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
