/**
 * Exponential backoff with random jitter.
 *
 * Random jitter prevents reconnect thundering herds when the core service restarts.
 *
 * Counters reset only upon a verified established connection.
 */

export interface BackoffOptions {
  minMs: number;
  maxMs: number;
  /** Growth factor. 2 doubles interval on each failed attempt. */
  factor?: number;
  /** Random jitter fraction between 0 and 1. 0.3 = ±30%. */
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

  /** Calculates next delay in milliseconds and increments attempt count. */
  next(): number {
    const base = Math.min(this.#minMs * this.#factor ** this.#attempt, this.#maxMs);
    this.#attempt += 1;

    const spread = base * this.#jitter;
    const delay = base - spread + this.#random() * spread * 2;

    // Jitter must never fall below minimum or exceed maximum ceiling.
    return Math.round(Math.min(Math.max(delay, this.#minMs), this.#maxMs));
  }

  /** Resets attempt counter following successful connection establishment. */
  reset(): void {
    this.#attempt = 0;
  }
}
