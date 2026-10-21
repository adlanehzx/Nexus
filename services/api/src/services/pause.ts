import { z } from "zod";
import { AppError } from "@nexus/shared";
import type { RuntimeConfigurationStore } from "./runtime-configuration.js";

/**
 * Pause globale.
 *
 * ## Ce que « pause » veut dire, précisément
 *
 * **Lire continue, agir s'arrête.** C'est la seule définition utile pour un
 * assistant personnel : on met NEXUS en pause parce qu'on ne veut plus qu'il
 * *fasse* des choses — pas parce qu'on veut qu'il devienne aveugle. Un agent en
 * pause peut encore consulter, résumer, répondre ; il ne peut plus envoyer,
 * écrire, exécuter, acheter.
 *
 * Techniquement, cela tombe exactement sur le coupe-circuit qui existait déjà
 * dans `PermissionService` : `readOnly` refuse tout outil de risque `LOW` ou
 * plus, et laisse passer `SAFE`. L'échelle de risque portait donc déjà la
 * bonne frontière ; il manquait seulement de quoi l'actionner.
 *
 * ## Trois propriétés, et pourquoi chacune
 *
 * **Elle survit à un redémarrage.** Une pause qui s'oublie est pire que pas de
 * pause : on croit NEXUS arrêté, il ne l'est plus, et personne n'est prévenu.
 * L'état est donc écrit sur disque, par la même écriture atomique que le reste
 * de la configuration.
 *
 * **Elle porte un motif et une date.** « Rien ne se passe » est le symptôme le
 * plus coûteux à diagnostiquer. Une interface qui peut dire « en pause depuis
 * 14h02 : réunion » transforme une énigme en information.
 *
 * **Elle ne peut pas s'enfermer.** Reprendre est une action, et si la pause
 * refusait les actions sans exception, elle interdirait sa propre levée. La
 * route de reprise ne consulte donc pas la pause — elle la modifie.
 */

export const pauseStateSchema = z.object({
  paused: z.boolean(),
  /** Pourquoi, tel que la personne l'a écrit. Jamais imposé. */
  reason: z.string().max(200).nullable(),
  /** Depuis quand, en ISO 8601. Nul quand rien n'est en pause. */
  since: z.string().datetime().nullable(),
});

export type PauseState = z.infer<typeof pauseStateSchema>;

const RUNNING: PauseState = { paused: false, reason: null, since: null };

export class SystemPausedError extends AppError {
  readonly code = "SYSTEM_PAUSED";
  readonly httpStatus = 409;

  constructor(state: PauseState) {
    super({
      message: "NEXUS est en pause",
      userMessage:
        state.reason === null
          ? "NEXUS est en pause. Reprenez-le pour relancer des actions."
          : `NEXUS est en pause : ${state.reason}. Reprenez-le pour relancer des actions.`,
      context: { since: state.since },
    });
  }
}

export interface PauseSwitchOptions {
  /**
   * Persistance. Absente, la pause ne vit qu'en mémoire.
   *
   * C'est le cas des tests, et ce n'en est pas un en production : sans
   * persistance, un redémarrage lèverait la pause en silence.
   */
  store?: RuntimeConfigurationStore;
  now?: () => Date;
}

export class PauseSwitch {
  readonly #store: RuntimeConfigurationStore | undefined;
  readonly #now: () => Date;
  #state: PauseState = RUNNING;

  constructor(options: PauseSwitchOptions = {}) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Relit l'état depuis le disque.
   *
   * Appelée au démarrage. Synchrone dans son usage — `paused` doit répondre
   * sans attendre, parce qu'il est consulté sur le chemin de chaque
   * autorisation — d'où cette lecture explicite une fois pour toutes plutôt
   * qu'un accès au disque par appel.
   */
  async restore(): Promise<PauseState> {
    if (this.#store === undefined) return this.#state;
    const loaded = await this.#store.loadPause();
    if (loaded !== null) this.#state = loaded;
    return this.#state;
  }

  get state(): PauseState {
    return { ...this.#state };
  }

  get paused(): boolean {
    return this.#state.paused;
  }

  async set(paused: boolean, reason?: string): Promise<PauseState> {
    // Mettre en pause ce qui l'est déjà ne déplace pas la date : on veut savoir
    // depuis quand, pas depuis le dernier clic.
    if (paused && this.#state.paused) {
      if (reason !== undefined) {
        this.#state = { ...this.#state, reason };
        await this.#persist();
      }
      return this.state;
    }

    this.#state = paused
      ? { paused: true, reason: reason ?? null, since: this.#now().toISOString() }
      : RUNNING;
    await this.#persist();
    return this.state;
  }

  /** Lève `SystemPausedError` si NEXUS est en pause. */
  assertRunning(): void {
    if (this.#state.paused) throw new SystemPausedError(this.#state);
  }

  async #persist(): Promise<void> {
    if (this.#store === undefined) return;
    await this.#store.savePause(this.#state);
  }
}
