import { PolicyViolationError } from "@nexus/worker-core";

/**
 * Screenshot policy.
 */

/** Maximum accepted dimension, in pixels. */
const DEFAULT_MAX_DIMENSION = 1280;
const HARD_MAX_DIMENSION = 2048;

/** Maximum encoded image size, in bytes. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** Minimum interval between two captures. */
const DEFAULT_MIN_INTERVAL_MS = 1_000;

export interface ScreenshotPolicyOptions {
  maxDimension?: number;
  maxBytes?: number;
  /** Minimum interval between two captures. */
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
   * Authorizes a capture, or rejects if preceding capture was too recent.
   *
   * @throws {PolicyViolationError} on excessive rate.
   */
  assertCaptureAllowed(): void {
    const now = this.#now();
    const elapsed = now - this.#lastCaptureAt;

    if (this.#lastCaptureAt !== 0 && elapsed < this.#minIntervalMs) {
      throw new PolicyViolationError({
        rule: "screenshot.rate",
        message: `Capture too frequent (${String(elapsed)} ms)`,
        userMessage: "A screenshot was just taken. NEXUS does not capture the screen continuously.",
        context: { elapsedMs: elapsed, minIntervalMs: this.#minIntervalMs },
      });
    }

    this.#lastCaptureAt = now;
  }

  /**
   * Validates captured image.
   *
   * @throws {PolicyViolationError} if image exceeds bounds.
   */
  assertWithinLimits(image: { bytes: number; width: number; height: number }): void {
    if (image.bytes > this.#maxBytes) {
      throw new PolicyViolationError({
        rule: "screenshot.tooLarge",
        message: `Capture too large (${String(image.bytes)} bytes)`,
        userMessage: "The screenshot exceeds the allowed size.",
        context: { bytes: image.bytes, max: this.#maxBytes },
      });
    }

    const largest = Math.max(image.width, image.height);
    if (largest > this.#maxDimension) {
      throw new PolicyViolationError({
        rule: "screenshot.tooBig",
        message: `Capture too big (${String(largest)} px)`,
        userMessage: "The screenshot exceeds the allowed resolution.",
        context: { largest, max: this.#maxDimension },
      });
    }
  }
}
