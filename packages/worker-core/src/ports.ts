import type { WorkerHealth } from "@nexus/protocol";

/**
 * Ce qu'un exécutant doit fournir, et que le runtime commun ignore.
 *
 * Trois ports, pas un de plus. Tout le reste — cycle de vie, poignée de main,
 * registre de capacités, exécution, reprise, journalisation — est identique
 * d'une plateforme à l'autre et vit dans ce paquet.
 *
 * C'est la raison d'être de `@nexus/worker-core` : le worker Windows et le
 * worker Android partagent le même code de coordination. Les dupliquer aurait
 * créé un second système de capacités et un second cycle de vie, avec la
 * garantie qu'ils divergent au premier correctif appliqué d'un seul côté.
 */

/**
 * Signature du challenge d'authentification.
 *
 * La clé privée ne quitte jamais l'appareil et n'est jamais transmise : le
 * worker prouve qu'il la détient en signant un nonce à usage unique. Un jeton
 * dérobé dans un journal ne permet donc pas de se faire passer pour lui.
 *
 * Les implémentations diffèrent radicalement selon la plateforme — un fichier
 * PEM sous Windows, le magasin de clés matériel sous Android — et c'est
 * précisément pourquoi c'est un port.
 */
export interface CredentialSigner {
  /** Signe un nonce. Retour en base64, comme l'attend `DeviceSessionService`. */
  sign(nonce: string): Promise<string>;
}

/**
 * État de santé remonté au cœur.
 *
 * Strictement ce dont `DeviceSelector` a besoin pour répondre à « puis-je
 * confier une tâche à cet appareil ? ». Pas d'inventaire matériel, pas de nom
 * d'utilisateur, pas de liste de processus.
 */
export interface HealthSource {
  snapshot(): WorkerHealth;
  /** L'appareil peut-il accepter une tâche de plus ? */
  hasCapacity(): boolean;
  /**
   * L'appareil est-il dégradé ?
   *
   * Un téléphone à 8 % de batterie reste joignable et parfaitement capable ;
   * il ne doit simplement plus recevoir de tâche non essentielle. C'est un état
   * distinct de « hors ligne », et le sélecteur en tient compte.
   */
  isDegraded(): boolean;
}

/** Minuteries injectables — les tests de reprise n'attendent pas réellement. */
export interface TimerPort {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export const systemTimers: TimerPort = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
