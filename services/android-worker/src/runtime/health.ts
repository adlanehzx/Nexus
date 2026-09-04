import type { WorkerHealth } from "@nexus/protocol";
import type { HealthSource } from "@nexus/worker-core";
import type { AndroidBatteryState, AndroidDeviceInspector } from "../ports.js";

/**
 * Santé du téléphone.
 *
 * Sur un ordinateur de bureau, la santé sert surtout à répartir la charge. Sur
 * un téléphone, elle sert d'abord à **protéger l'appareil de l'assistant** : un
 * téléphone à 8 % de batterie reste parfaitement joignable et capable, mais
 * exécuter une automatisation d'interface dessus va le vider et couper la
 * sonnerie du réveil.
 *
 * D'où l'état **dégradé** : distinct de « hors ligne », il dit au sélecteur
 * « disponible, mais évite-moi si tu as le choix ». `DeviceSelector` sait déjà
 * le lire — il n'y avait rien à ajouter côté cœur.
 *
 * Ce qui est remonté s'arrête là. Pas de position, pas de réseau mobile, pas de
 * liste d'applications ouvertes, pas d'identité. Un téléphone personnel n'a pas
 * à se faire superviser pour rendre service.
 */

/** En dessous, et sans charge en cours, l'appareil se déclare dégradé. */
export const DEFAULT_LOW_BATTERY_PERCENT = 20;

/** En dessous, il refuse toute nouvelle tâche. */
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

  /**
   * Dernier état connu de la batterie.
   *
   * Lu de façon asynchrone par Android, alors que `snapshot()` doit répondre
   * immédiatement — le battement de cœur ne peut pas attendre une lecture
   * système. On rafraîchit en arrière-plan et on sert la dernière valeur.
   */
  #battery: AndroidBatteryState = { percent: 100, charging: true, powerSaveMode: false };

  constructor(options: AndroidHealthSourceOptions) {
    this.#device = options.device;
    this.#maxConcurrent = options.maxConcurrentTasks;
    this.#activeTasks = options.activeTasks;
    this.#low = options.lowBatteryPercent ?? DEFAULT_LOW_BATTERY_PERCENT;
    this.#critical = options.criticalBatteryPercent ?? DEFAULT_CRITICAL_BATTERY_PERCENT;
  }

  /** Relit l'état de la batterie. Appelé avant chaque battement de cœur. */
  async refresh(): Promise<void> {
    try {
      this.#battery = await this.#device.batteryState();
    } catch {
      // Une lecture qui échoue ne doit pas faire tomber le battement de cœur.
      // On garde la dernière valeur connue : mieux vaut une santé un peu vieille
      // qu'un worker qui disparaît du registre.
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
      // Un appareil dégradé annonce une capacité réduite : le sélecteur le voit
      // saturé plus vite, sans qu'il faille lui apprendre ce qu'est une batterie.
      maxConcurrentTasks: this.isDegraded() ? 1 : this.#maxConcurrent,
    };
  }

  hasCapacity(): boolean {
    // En dessous du seuil critique, l'appareil n'accepte plus rien : terminer
    // une tâche en cours et s'éteindre est pire que de la refuser tout de suite.
    if (!this.#battery.charging && this.#battery.percent <= this.#critical) return false;

    return this.#activeTasks() < (this.isDegraded() ? 1 : this.#maxConcurrent);
  }

  /**
   * Dégradé : disponible, mais à éviter si un autre exécutant convient.
   *
   * Deux causes, et le mode économie d'énergie compte autant que le niveau :
   * Android y bride les tâches de fond et diffère les alarmes, ce qui rend les
   * délais d'exécution imprévisibles.
   */
  isDegraded(): boolean {
    if (this.#battery.charging) return false;
    return this.#battery.percent <= this.#low || this.#battery.powerSaveMode;
  }
}
