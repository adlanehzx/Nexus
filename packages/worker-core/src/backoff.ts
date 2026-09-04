/**
 * Attente exponentielle avec bruit.
 *
 * Le bruit n'est pas un raffinement. Sans lui, tous les workers d'un
 * utilisateur — portable, poste fixe, Android — reconnectent à la même
 * milliseconde après une coupure du cœur, et le font retomber au moment précis
 * où il redémarre. Une tempête de reconnexions transforme une panne de dix
 * secondes en panne de dix minutes.
 *
 * Le décompte se remet à zéro sur une connexion **réellement établie**, pas sur
 * une tentative : un worker qui se connecte puis se fait fermer aussitôt ne doit
 * pas repartir à une seconde indéfiniment.
 */

export interface BackoffOptions {
  minMs: number;
  maxMs: number;
  /** Facteur de croissance. 2 double à chaque échec. */
  factor?: number;
  /** Part aléatoire, de 0 à 1. 0,3 = ±30 %. */
  jitter?: number;
  random?: () => number;
}

export class Backoff {
  readonly #minMs: number;
  readonly #maxMs: number;
  readonly #factor: number;
  readonly #jitter: number;
  readonly #random: () => number;

  #attempt = 0;

  constructor(options: BackoffOptions) {
    this.#minMs = options.minMs;
    this.#maxMs = options.maxMs;
    this.#factor = options.factor ?? 2;
    this.#jitter = options.jitter ?? 0.3;
    this.#random = options.random ?? Math.random;
  }

  get attempt(): number {
    return this.#attempt;
  }

  /** Prochain délai, en millisecondes. Incrémente le compteur. */
  next(): number {
    const base = Math.min(this.#minMs * this.#factor ** this.#attempt, this.#maxMs);
    this.#attempt += 1;

    const spread = base * this.#jitter;
    const delay = base - spread + this.#random() * spread * 2;

    // Le bruit ne doit jamais faire descendre sous le minimum ni dépasser le
    // plafond : ce sont des garanties, pas des indications.
    return Math.round(Math.min(Math.max(delay, this.#minMs), this.#maxMs));
  }

  /** Après une connexion établie. */
  reset(): void {
    this.#attempt = 0;
  }
}
