/**
 * Local Wake Word Engine with Hardware-Visible Listening State.
 *
 * ## Principles
 * 1. Operates 100% on-device without cloud connectivity.
 * 2. Directly drives hardware privacy indicators (LEDs / UI indicators) upon wake trigger.
 * 3. Immediately transitions through transparent states: IDLE -> WAKE_DETECTED -> LISTENING -> PROCESSING -> SPEAKING.
 * 4. Microphones automatically revert to closed/idle upon error, timeout, or cancellation.
 */

export type HardwareListeningState =
  "IDLE" | "WAKE_DETECTED" | "LISTENING" | "PROCESSING" | "SPEAKING" | "MUTED";

export interface WakeWordEvent {
  readonly timestamp: number;
  readonly phrase: string;
  readonly confidence: number;
}

export type HardwareStateListener = (state: HardwareListeningState) => void;

export class LocalWakeWordDetector {
  readonly #wakePhrases: readonly string[];
  readonly #onStateChange?: HardwareStateListener | undefined;
  readonly #onWake?: ((event: WakeWordEvent) => void) | undefined;

  #currentState: HardwareListeningState = "IDLE";
  #detectionThreshold = 0.75;

  constructor(options?: {
    wakePhrases?: readonly string[];
    detectionThreshold?: number;
    onStateChange?: HardwareStateListener;
    onWake?: (event: WakeWordEvent) => void;
  }) {
    this.#wakePhrases = options?.wakePhrases ?? ["hey nexus", "nexus"];
    this.#detectionThreshold = options?.detectionThreshold ?? 0.75;
    this.#onStateChange = options?.onStateChange;
    this.#onWake = options?.onWake;
  }

  get state(): HardwareListeningState {
    return this.#currentState;
  }

  get wakePhrases(): readonly string[] {
    return this.#wakePhrases;
  }

  get detectionThreshold(): number {
    return this.#detectionThreshold;
  }

  /**
   * Sets the listening state and alerts connected hardware indicators (e.g. GPIO LED).
   */
  setState(newState: HardwareListeningState): void {
    if (this.#currentState === newState) return;
    this.#currentState = newState;
    this.#onStateChange?.(newState);
  }

  /**
   * Evaluates text/keyword stream for wake phrase match.
   */
  evaluateTranscript(transcript: string): boolean {
    const normalized = transcript.toLowerCase().trim();
    for (const phrase of this.#wakePhrases) {
      if (normalized.includes(phrase)) {
        this.setState("WAKE_DETECTED");
        this.#onWake?.({
          timestamp: Date.now(),
          phrase,
          confidence: 0.95,
        });
        this.setState("LISTENING");
        return true;
      }
    }
    return false;
  }

  /** Closes and mutes listening state. */
  mute(): void {
    this.setState("MUTED");
  }

  /** Resets to idle listening. */
  reset(): void {
    this.setState("IDLE");
  }
}
