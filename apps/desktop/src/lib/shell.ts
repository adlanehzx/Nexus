import type { SecureStorage } from "@nexus/client-core";

/**
 * Ce que la coquille de bureau apporte, et **rien de plus**.
 *
 * Ce port est la frontière entre l'interface et le système d'exploitation. Sa
 * définition est donc autant une liste de ce qui est offert qu'une liste de ce
 * qui est refusé.
 *
 * Ce qui n'y figure pas, et n'y figurera pas :
 *
 *  - exécuter une commande, lancer un processus, tuer un processus ;
 *  - lire ou écrire un fichier arbitraire ;
 *  - parler à Docker, à Git, au démon worker.
 *
 * Le portable est à la fois client et exécutant, mais **ce sont deux processus
 * distincts avec deux secrets distincts**. L'interface tient les jetons de
 * l'utilisateur ; le démon tient la clé privée de la machine. Si cette fenêtre
 * pouvait exécuter localement, la séparation ne vaudrait plus rien : une page
 * compromise deviendrait un shell, et la chaîne
 * `cœur → autorisation → capacité → exécution` serait contournable depuis le
 * poste lui-même.
 *
 * Le seul chemin de l'interface vers la machine passe donc par le réseau, par
 * le cœur, et par les mêmes contrôles que depuis l'iPhone. C'est plus long. Il
 * n'y a pas de raccourci, et c'est le but.
 */
export interface DesktopShell {
  /** Coquille réellement en place. L'interface s'y adapte, sans se dégrader en silence. */
  readonly kind: ShellKind;

  /**
   * Coffre local.
   *
   * Sous Tauri, le gestionnaire d'identifiants de Windows — chiffré par le
   * système, lié au compte utilisateur. Dans un navigateur, la mémoire du
   * processus : voir `VolatileStorage`.
   */
  readonly storage: SecureStorage;

  /** Notification du système. Silencieuse si la coquille n'en sait rien faire. */
  notify(input: {
    title: string;
    body: string;
    severity: "info" | "warning" | "error";
  }): Promise<void>;

  /**
   * Identifiant de l'exécutant installé sur cette machine, s'il y en a un.
   *
   * Lu dans le fichier d'état public du démon. **Un identifiant, jamais un
   * secret** : il ne donne aucun droit, il permet seulement à l'interface de
   * reconnaître « cette machine » dans la liste que le cœur lui renvoie. La clé
   * privée du worker vit ailleurs et n'est jamais lisible d'ici.
   */
  localWorkerDeviceId(): Promise<string | null>;

  /** Nom de la machine, proposé au moment de l'appairage. */
  machineName(): Promise<string>;

  /** Ouvre une URL dans le navigateur par défaut. */
  openExternal(url: string): Promise<void>;
}

export type ShellKind = "tauri" | "web";

/**
 * Coffre volatil, pour l'exécution hors coquille native.
 *
 * Il **oublie tout** à la fermeture de l'onglet, et c'est délibéré : écrire un
 * jeton de rafraîchissement dans `localStorage` le rendrait lisible par
 * n'importe quel script de la page, pour trente jours. Un développeur qui doit
 * se reconnecter à chaque rechargement est un inconvénient ; un jeton de longue
 * durée en clair est une faille.
 */
export class VolatileStorage implements SecureStorage {
  readonly #values = new Map<string, string>();

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.#values.get(key));
  }

  set(key: string, value: string): Promise<void> {
    this.#values.set(key, value);
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.#values.delete(key);
    return Promise.resolve();
  }
}
