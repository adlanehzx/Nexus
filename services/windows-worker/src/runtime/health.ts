import os from "node:os";
import type { WorkerHealth } from "@nexus/protocol";
import type { HealthSource } from "@nexus/worker-core";

/**
 * Santé locale.
 *
 * Strictement ce dont le sélecteur a besoin pour répondre à « puis-je confier
 * une tâche à cette machine ? ». Pas de liste de processus, pas de nom
 * d'utilisateur, pas d'inventaire matériel, pas d'adresse réseau. Une machine
 * personnelle n'a pas à se faire superviser pour rendre service.
 *
 * `activeTasks` et `maxConcurrentTasks` sont les deux champs qui comptent
 * vraiment : c'est sur eux que `DeviceSelector` calcule la saturation, et donc
 * répartit entre le portable et le poste fixe.
 */

export interface NodeHealthSourceOptions {
  maxConcurrentTasks: number;
  /** Nombre de tâches en cours. Fourni par l'exécuteur. */
  activeTasks: () => number;
  /** Injectables pour les tests — sinon, `node:os`. */
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

  /** L'appareil peut-il accepter une tâche de plus ? */
  hasCapacity(): boolean {
    return this.#activeTasks() < this.#maxConcurrent;
  }

  /**
   * Un poste de travail n'est jamais dégradé au sens du sélecteur.
   *
   * La notion existe pour les appareils sur batterie — un téléphone à 8 % reste
   * joignable mais ne doit plus recevoir de tâche non essentielle. Une machine
   * de bureau branchée au secteur n'a pas d'équivalent.
   */
  isDegraded(): boolean {
    return false;
  }
}

/**
 * Charge processeur, de 0 à 1.
 *
 * Windows ne renseigne pas `os.loadavg()` — il renvoie toujours zéro. On se
 * rabat sur le rapport entre le temps inactif cumulé et le temps total depuis le
 * démarrage : ce n'est pas une charge instantanée, mais c'est une valeur réelle,
 * et surtout comparable entre deux machines, ce qui est tout ce que le sélecteur
 * demande.
 */
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
