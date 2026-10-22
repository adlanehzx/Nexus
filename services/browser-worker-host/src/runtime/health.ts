import type { WorkerHealth } from "@nexus/protocol";
import type { HealthSource } from "@nexus/worker-core";
import type { BrowserWorkerClient } from "@nexus/browser-client";

/**
 * Santé de l'exécutant navigateur.
 *
 * Elle ne décrit pas la machine : elle décrit **le service qui détient les
 * navigateurs**. Un hôte parfaitement sain devant un worker Python injoignable
 * n'est pas sain — il se ferait choisir par le sélecteur et échouerait.
 *
 * D'où deux notions distinctes, et le sélecteur s'en sert différemment :
 *
 *  - **plus de capacité** — le worker Python a déjà autant de navigateurs
 *    ouverts qu'il en accepte. L'étape attendra plutôt que d'échouer.
 *  - **dégradé** — le worker Python se déclare `degraded`, ou n'a pas répondu
 *    au dernier sondage. L'appareil reste joignable ; on évite simplement de
 *    lui confier ce qui peut aller ailleurs.
 *
 * L'état est **rafraîchi explicitement**, jamais lu au moment du battement :
 * `snapshot()` est synchrone dans le port `HealthSource`, et un appel réseau
 * caché derrière un accesseur synchrone est une source de blocages.
 */

export interface BrowserHealthOptions {
  client: BrowserWorkerClient;
  maxConcurrentTasks: number;
  /** Tâches en cours côté hôte, lues sur le runtime. */
  activeTasks: () => number;
}

export class BrowserHealthSource implements HealthSource {
  readonly #options: BrowserHealthOptions;

  /** Dernier état connu du worker Python. `undefined` = jamais interrogé. */
  #status: "ok" | "degraded" | "unreachable" | undefined;
  #openSessions = 0;
  #browserUseVersion: string | null = null;

  constructor(options: BrowserHealthOptions) {
    this.#options = options;
  }

  get status(): string {
    return this.#status ?? "unknown";
  }

  get browserUseVersion(): string | null {
    return this.#browserUseVersion;
  }

  /** Interroge le worker Python. À appeler au démarrage et périodiquement. */
  async refresh(): Promise<void> {
    try {
      const health = await this.#options.client.health();
      this.#status = health.status;
      this.#openSessions = health.openSessions;
      this.#browserUseVersion = health.browserUseVersion;
    } catch {
      // Injoignable : on le retient plutôt que de le taire. Le détail de
      // l'erreur ne remonte pas — il nommerait un service interne.
      this.#status = "unreachable";
      this.#openSessions = 0;
    }
  }

  snapshot(): WorkerHealth {
    return {
      activeTasks: this.#options.activeTasks(),
      maxConcurrentTasks: this.#options.maxConcurrentTasks,
    };
  }

  hasCapacity(): boolean {
    if (this.#status === "unreachable") return false;
    return this.#options.activeTasks() < this.#options.maxConcurrentTasks;
  }

  isDegraded(): boolean {
    return this.#status === "degraded" || this.#status === "unreachable";
  }

  /** Diagnostic pour les journaux. Aucune donnée de navigation n'y figure. */
  describe(): Record<string, unknown> {
    return {
      status: this.status,
      openSessions: this.#openSessions,
      browserUseVersion: this.#browserUseVersion,
      activeTasks: this.#options.activeTasks(),
      maxConcurrentTasks: this.#options.maxConcurrentTasks,
    };
  }
}
