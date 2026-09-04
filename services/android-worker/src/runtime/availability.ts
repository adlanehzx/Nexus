import type { WorkerLogger } from "@nexus/worker-core";
import type { AndroidPlatform } from "../ports.js";

/**
 * Surveillance de la disponibilité des capacités.
 *
 * Sur un poste de travail, ce qu'un worker sait faire ne change pas : Git est
 * installé ou ne l'est pas. Sur un téléphone, **cela change en permanence, et
 * c'est voulu** — l'utilisateur désactive le service d'accessibilité parce qu'il
 * prête son téléphone, révoque les notifications, redémarre.
 *
 * Sans surveillance, le cœur continuerait de croire que `android.ui.click` est
 * disponible, le sélecteur choisirait le Redmi, et l'étape échouerait après
 * avoir écarté un exécutant capable. La réannonce n'est donc pas un confort :
 * c'est ce qui rend la sélection honnête.
 *
 * Le sondage est périodique et non événementiel, faute de diffusion système pour
 * l'activation d'un service d'accessibilité. L'intervalle est large — quelques
 * dizaines de secondes — parce que la vérification touche le système et que
 * l'utilisateur ne bascule pas ces réglages toutes les secondes.
 */

export interface AvailabilitySnapshot {
  accessibility: boolean;
  screenshot: boolean;
  notifications: boolean;
}

export interface AvailabilityWatcherOptions {
  platform: AndroidPlatform;
  logger: WorkerLogger;
  /** Appelée quand la disponibilité change. Réannonce les capacités au cœur. */
  onChange: (snapshot: AvailabilitySnapshot) => Promise<void> | void;
}

export class AvailabilityWatcher {
  readonly #platform: AndroidPlatform;
  readonly #logger: WorkerLogger;
  readonly #onChange: AvailabilityWatcherOptions["onChange"];

  #last: AvailabilitySnapshot | undefined;

  constructor(options: AvailabilityWatcherOptions) {
    this.#platform = options.platform;
    this.#logger = options.logger;
    this.#onChange = options.onChange;
  }

  get last(): AvailabilitySnapshot | undefined {
    return this.#last;
  }

  /**
   * Relève l'état sans le signaler.
   *
   * Appelé au démarrage, avant la connexion : les capacités seront annoncées
   * par la poignée de main elle-même. Sans cette amorce, la première
   * vérification périodique croirait à un changement et réannoncerait une liste
   * identique, quelques secondes après l'avoir déjà envoyée.
   */
  async prime(): Promise<AvailabilitySnapshot> {
    this.#last = await this.probe();
    return this.#last;
  }

  /** Interroge le système. Chaque test est indépendant des autres. */
  async probe(): Promise<AvailabilitySnapshot> {
    const [accessibility, screenshot, notifications] = await Promise.all([
      this.#safely(() => this.#platform.ui.isAccessibilityEnabled()),
      this.#safely(() => this.#platform.screenshots.isAvailable()),
      this.#safely(() => this.#platform.notifications.canPostNotifications()),
    ]);

    return { accessibility, screenshot, notifications };
  }

  /**
   * Sonde, et signale si quelque chose a changé.
   *
   * Renvoie `true` quand un changement a été signalé — ce que les tests
   * observent, et ce qui déclenche la réannonce.
   */
  async check(): Promise<boolean> {
    const snapshot = await this.probe();

    if (this.#last !== undefined && sameSnapshot(this.#last, snapshot)) {
      this.#last = snapshot;
      return false;
    }

    const previous = this.#last;
    this.#last = snapshot;

    // Premier passage : on note l'état sans le présenter comme un changement,
    // mais on réannonce quand même — le cœur doit connaître l'état initial.
    this.#logger.info(
      previous === undefined ? "disponibilité initiale" : "disponibilité modifiée",
      {
        accessibilité: snapshot.accessibility,
        capture: snapshot.screenshot,
        notifications: snapshot.notifications,
      },
    );

    await this.#onChange(snapshot);
    return true;
  }

  /** Une sonde qui échoue vaut une indisponibilité : dans le doute, on n'annonce pas. */
  async #safely(probe: () => Promise<boolean>): Promise<boolean> {
    try {
      return await probe();
    } catch {
      return false;
    }
  }
}

function sameSnapshot(a: AvailabilitySnapshot, b: AvailabilitySnapshot): boolean {
  return (
    a.accessibility === b.accessibility &&
    a.screenshot === b.screenshot &&
    a.notifications === b.notifications
  );
}
