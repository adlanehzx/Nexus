import { AppError } from "@nexus/shared";
import type { FilePort } from "./ports.js";

/**
 * Fichiers audio temporaires, et la garantie qu'il n'en reste aucun.
 *
 * ## Pourquoi c'est un module à part
 *
 * « Aucun audio conservé » est la promesse la plus facile à faire et la plus
 * facile à trahir. Il suffit d'un `return` anticipé, d'une exception non
 * attrapée, ou d'un processus tué au mauvais moment pour qu'un enregistrement
 * de la cuisine reste sur le disque. Une promesse de ce genre ne tient pas par
 * la discipline : elle tient par un endroit unique qui la fait respecter, et
 * par des tests qui l'attaquent.
 *
 * ## Les trois règles
 *
 * 1. **Un seul dossier.** Tout l'audio temporaire y vit, en 0700. On sait donc
 *    où regarder, et `purge()` peut tout effacer sans deviner.
 * 2. **La suppression est vérifiée.** Supprimer puis constater que le fichier
 *    a disparu — un `unlink` dont on ignore le résultat n'est pas une
 *    suppression, c'est une intention.
 * 3. **Le nettoyage passe par `finally`.** L'appelant n'a pas le choix : la
 *    méthode `withAudio` prête un chemin et reprend la main quoi qu'il arrive.
 *
 * ## Ce que ça ne garantit pas, et il faut le savoir
 *
 * Que les octets ne sont plus récupérables sur le support. Un `unlink` délie un
 * nom, il ne réécrit pas les secteurs — et sur un SSD, aucune réécriture
 * logicielle ne le garantit vraiment. La promesse tenue est « NEXUS ne conserve
 * aucun fichier audio », pas « l'audio est effacé de façon médico-légale ».
 * Confondre les deux serait rassurer à tort.
 */

export type AudioRetention =
  /** Défaut : rien n'est conservé, et la suppression est vérifiée. */
  | "aucune"
  /**
   * Conserve les enregistrements, pour diagnostiquer un problème de
   * transcription. Jamais par défaut, et annoncé bruyamment : c'est une
   * décision, pas une option de confort.
   */
  | "diagnostic";

export class AudioNotDeletedError extends AppError {
  readonly code = "AUDIO_NOT_DELETED";
  readonly httpStatus = 500;

  constructor(path: string) {
    super({
      message: `l'enregistrement n'a pas pu être supprimé : ${path}`,
      userMessage:
        "NEXUS could not delete a temporary recording. Dictation is stopped as a precaution.",
      context: { path },
    });
  }
}

export interface AudioScratchOptions {
  files: FilePort;
  /** Dossier des enregistrements temporaires. */
  directory: string;
  retention?: AudioRetention;
  /** Noms uniques, remplaçables pour les tests. */
  newName?: () => string;
  /** Averti quand la rétention « diagnostic » laisse un fichier derrière elle. */
  onRetained?: (path: string) => void;
}

export class AudioScratch {
  readonly #files: FilePort;
  readonly #directory: string;
  readonly #retention: AudioRetention;
  readonly #newName: () => string;
  readonly #onRetained: ((path: string) => void) | undefined;
  #counter = 0;

  constructor(options: AudioScratchOptions) {
    this.#files = options.files;
    this.#directory = options.directory;
    this.#retention = options.retention ?? "aucune";
    this.#newName =
      options.newName ??
      (() => {
        this.#counter += 1;
        return `dictee-${String(Date.now())}-${String(this.#counter)}.wav`;
      });
    this.#onRetained = options.onRetained;
  }

  get retention(): AudioRetention {
    return this.#retention;
  }

  get directory(): string {
    return this.#directory;
  }

  /**
   * Prête un chemin audio, puis le reprend.
   *
   * `finally` et non un appel de nettoyage laissé à l'appelant : c'est ce qui
   * rend la garantie vraie même quand la transcription échoue, ce qui est
   * justement le moment où l'on oublierait.
   */
  async withAudio<T>(operation: (path: string) => Promise<T>): Promise<T> {
    await this.#files.mkdir(this.#directory);
    const path = `${this.#directory}/${this.#newName()}`;
    try {
      return await operation(path);
    } finally {
      await this.#release(path);
    }
  }

  /** Efface tout ce qui traîne. Appelé au démarrage, et après un arrêt brutal. */
  async purge(names: readonly string[]): Promise<number> {
    let removed = 0;
    for (const name of names) {
      const path = `${this.#directory}/${name}`;
      if (!(await this.#files.exists(path))) continue;
      await this.#files.remove(path);
      if (await this.#files.exists(path)) throw new AudioNotDeletedError(path);
      removed += 1;
    }
    return removed;
  }

  async #release(path: string): Promise<void> {
    if (this.#retention === "diagnostic") {
      if (await this.#files.exists(path)) this.#onRetained?.(path);
      return;
    }
    if (!(await this.#files.exists(path))) return;
    await this.#files.remove(path);
    // Constater, et non supposer : un `unlink` dont on ignore le résultat est
    // une intention, pas une suppression.
    if (await this.#files.exists(path)) throw new AudioNotDeletedError(path);
  }
}
