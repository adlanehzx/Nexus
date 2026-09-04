import { PolicyViolationError } from "@nexus/worker-core";

/**
 * Politique de capture d'écran.
 *
 * Une capture d'écran de téléphone est la donnée la plus sensible que ce worker
 * puisse produire : elle contient ce que l'utilisateur regarde, y compris un
 * message privé, un code à usage unique ou un relevé bancaire.
 *
 * D'où trois règles, appliquées sans exception :
 *
 *  1. **jamais journalisée** — ni l'image, ni son encodage, ni un extrait ;
 *  2. **jamais écrite sur disque** — l'image vit en mémoire, traverse le canal,
 *     et disparaît. Un fichier temporaire survit à un plantage, se retrouve dans
 *     une sauvegarde automatique, et reste lisible par toute application ayant
 *     accès au stockage partagé ;
 *  3. **bornée en taille** — une capture pleine résolution pèse plusieurs
 *     mégaoctets, sature le canal et finit dans une fenêtre de contexte.
 *
 * Et une règle sur la fréquence : ce worker ne capture que sur demande explicite.
 * Il n'existe aucun code d'enregistrement continu, et l'API retenue —
 * `AccessibilityService.takeScreenshot()` — ne permet structurellement pas d'en
 * écrire un.
 */

/** Plus grand côté accepté, en pixels. */
const DEFAULT_MAX_DIMENSION = 1280;
const HARD_MAX_DIMENSION = 2048;

/** Taille maximale de l'image encodée, en octets. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** Intervalle minimal entre deux captures. */
const DEFAULT_MIN_INTERVAL_MS = 1_000;

export interface ScreenshotPolicyOptions {
  maxDimension?: number;
  maxBytes?: number;
  /**
   * Intervalle minimal entre deux captures.
   *
   * Ce n'est pas une optimisation : c'est ce qui empêche une suite de tâches
   * d'approcher un enregistrement continu par accumulation. Une capture par
   * seconde reste une série de captures ponctuelles ; dix par seconde est une
   * vidéo.
   */
  minIntervalMs?: number;
  now?: () => number;
}

export class ScreenshotPolicy {
  readonly #maxDimension: number;
  readonly #maxBytes: number;
  readonly #minIntervalMs: number;
  readonly #now: () => number;

  #lastCaptureAt = 0;

  constructor(options: ScreenshotPolicyOptions = {}) {
    this.#maxDimension = Math.min(
      options.maxDimension ?? DEFAULT_MAX_DIMENSION,
      HARD_MAX_DIMENSION,
    );
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  get maxDimension(): number {
    return this.#maxDimension;
  }

  /**
   * Autorise une capture, ou refuse si la précédente est trop récente.
   *
   * @throws {PolicyViolationError} en cas de cadence excessive.
   */
  assertCaptureAllowed(): void {
    const now = this.#now();
    const elapsed = now - this.#lastCaptureAt;

    if (this.#lastCaptureAt !== 0 && elapsed < this.#minIntervalMs) {
      throw new PolicyViolationError({
        rule: "screenshot.rate",
        message: `Capture trop rapprochée (${String(elapsed)} ms)`,
        userMessage:
          "Une capture d'écran vient d'être prise. NEXUS ne capture pas l'écran en continu.",
        context: { elapsedMs: elapsed, minIntervalMs: this.#minIntervalMs },
      });
    }

    this.#lastCaptureAt = now;
  }

  /**
   * Valide une image capturée.
   *
   * @throws {PolicyViolationError} si l'image dépasse les bornes. On refuse
   *   plutôt que de tronquer : une image tronquée est illisible, et la renvoyer
   *   ferait croire à une réussite.
   */
  assertWithinLimits(image: { bytes: number; width: number; height: number }): void {
    if (image.bytes > this.#maxBytes) {
      throw new PolicyViolationError({
        rule: "screenshot.tooLarge",
        message: `Capture trop lourde (${String(image.bytes)} octets)`,
        userMessage: "La capture d'écran dépasse la taille autorisée.",
        context: { bytes: image.bytes, max: this.#maxBytes },
      });
    }

    const largest = Math.max(image.width, image.height);
    if (largest > this.#maxDimension) {
      throw new PolicyViolationError({
        rule: "screenshot.tooBig",
        message: `Capture trop grande (${String(largest)} px)`,
        userMessage: "La capture d'écran dépasse la résolution autorisée.",
        context: { largest, max: this.#maxDimension },
      });
    }
  }
}
