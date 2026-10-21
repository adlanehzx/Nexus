import { redactText, truncate } from "@nexus/shared";

/**
 * Télémétrie de crash, locale par défaut.
 *
 * ## Ce que « télémétrie » veut dire ici
 *
 * Écrire la trace d'un plantage **sur la machine**, pour qu'on puisse la lire
 * après coup. Rien ne part : il n'y a pas de point de collecte, pas de clé
 * d'API, pas de requête sortante. Un rapport de crash contient des chemins de
 * fichiers, des noms de conversations, parfois des fragments de données
 * d'utilisateur — l'envoyer par défaut serait exactement le genre de décision
 * qu'un assistant personnel ne doit pas prendre à la place de son propriétaire.
 *
 * `share()` existe pour celui qui *veut* envoyer un rapport. Il rend le texte,
 * rédigé, et c'est l'appelant qui décide quoi en faire — coller dans un ticket,
 * l'oublier. Le module n'a pas de réseau.
 *
 * ## Pourquoi un module, et pas un `try/catch`
 *
 * Trois choses se trompent systématiquement quand on écrit cela à la main :
 *
 *  1. **Les secrets.** Une trace contient des en-têtes, des URL avec jeton, un
 *     mot de passe passé en argument. La rédaction passe par celle du reste du
 *     dépôt, pas par un filtre maison.
 *  2. **La taille.** Un plantage en boucle écrit mille rapports et remplit le
 *     disque — c'est-à-dire qu'il transforme un bug en panne.
 *  3. **La répétition.** Cent fois la même trace n'apporte rien de plus que la
 *     première, et noie la seconde cause.
 */

export interface CrashReport {
  id: string;
  at: number;
  /** Nom de l'erreur, par exemple `TypeError`. */
  kind: string;
  message: string;
  stack: string;
  /** Version de l'application, pour savoir ce qui plantait. */
  version: string;
  /** Combien de fois cette même trace a été vue. */
  occurrences: number;
  /** Ce que faisait l'application — jamais de données d'utilisateur. */
  context: Record<string, string>;
}

export interface CrashStore {
  all(): Promise<CrashReport[]>;
  save(reports: readonly CrashReport[]): Promise<void>;
}

export class InMemoryCrashStore implements CrashStore {
  #reports: CrashReport[] = [];

  all(): Promise<CrashReport[]> {
    return Promise.resolve(this.#reports.map((report) => ({ ...report })));
  }

  save(reports: readonly CrashReport[]): Promise<void> {
    this.#reports = reports.map((report) => ({ ...report }));
    return Promise.resolve();
  }
}

export interface CrashReporterOptions {
  store: CrashStore;
  version: string;
  now?: () => number;
  newId?: () => string;
  /** Nombre de rapports conservés. Au-delà, les plus anciens partent. */
  capacity?: number;
  /** Longueur maximale d'une pile. Une pile de 2 Mio n'aide personne. */
  maxStackChars?: number;
}

export class CrashReporter {
  readonly #store: CrashStore;
  readonly #version: string;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #capacity: number;
  readonly #maxStackChars: number;

  constructor(options: CrashReporterOptions) {
    this.#store = options.store;
    this.#version = options.version;
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? (() => `crash-${String(this.#now())}`);
    this.#capacity = options.capacity ?? 20;
    this.#maxStackChars = options.maxStackChars ?? 4_000;
  }

  /**
   * Enregistre un plantage.
   *
   * Une trace déjà vue n'est pas réécrite : son compteur monte. Cent fois la
   * même pile n'apporte rien de plus que la première, et noie la seconde cause
   * — qui est souvent la vraie.
   */
  async record(error: unknown, context: Record<string, string> = {}): Promise<CrashReport> {
    const kind = error instanceof Error ? error.name : typeof error;
    const message = redactText(error instanceof Error ? error.message : String(error));
    const stack = truncate(
      redactText(error instanceof Error ? (error.stack ?? "") : ""),
      this.#maxStackChars,
    );

    const reports = await this.#store.all();
    const seen = reports.find(
      (report) => report.kind === kind && report.message === message && report.stack === stack,
    );

    if (seen !== undefined) {
      const updated: CrashReport = { ...seen, occurrences: seen.occurrences + 1, at: this.#now() };
      await this.#store.save(reports.map((report) => (report.id === seen.id ? updated : report)));
      return updated;
    }

    const report: CrashReport = {
      id: this.#newId(),
      at: this.#now(),
      kind,
      message,
      stack,
      version: this.#version,
      occurrences: 1,
      context: Object.fromEntries(
        // Le contexte est rédigé lui aussi : c'est souvent là qu'un chemin ou
        // une URL avec jeton se glisse.
        Object.entries(context).map(([key, value]) => [key, redactText(truncate(value, 200))]),
      ),
    };
    // Un plantage en boucle écrirait mille rapports et remplirait le disque,
    // c'est-à-dire transformerait un bug en panne.
    await this.#store.save([...reports, report].slice(-this.#capacity));
    return report;
  }

  list(): Promise<CrashReport[]> {
    return this.#store.all();
  }

  /**
   * Rend un rapport lisible, à partager si on le décide.
   *
   * Le module n'a pas de réseau : il ne peut pas envoyer, donc il ne peut pas
   * envoyer par accident.
   */
  async share(id: string): Promise<string | undefined> {
    const report = (await this.#store.all()).find((candidate) => candidate.id === id);
    if (report === undefined) return undefined;
    return [
      `NEXUS ${report.version}`,
      `${report.kind} : ${report.message}`,
      `vu ${String(report.occurrences)} fois, dernière le ${new Date(report.at).toISOString()}`,
      ...Object.entries(report.context).map(([key, value]) => `${key} : ${value}`),
      "",
      report.stack,
    ].join("\n");
  }

  async clear(): Promise<void> {
    await this.#store.save([]);
  }
}
