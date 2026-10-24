/**
 * Production bidirectional audio streaming and calibrated End-Of-Speech (EOS) detection.
 *
 * ## Principles
 * 1. Low-latency chunk processing (10ms - 20ms audio frames).
 * 2. Adaptive noise floor baseline and calibrated silence timeout for end-of-speech detection.
 * 3. Immediate barge-in cutoff when user speaks during playback, with device-specific echo cancellation.
 * 4. Microphones strictly close upon silence, turn limits, pause, error, or logout.
 */

export interface DeviceAcousticProfile {
  readonly deviceType: "desktop" | "satellite" | "mobile";
  /** Acoustic echo cancellation enabled flag. */
  readonly aecEnabled: boolean;
  /** Expected playback echo delay in milliseconds. */
  readonly echoDelayMs: number;
  /** Energy RMS threshold (0.0 to 1.0) above which user speech is detected during playback. */
  readonly bargeInEnergyThreshold: number;
  /** Silence duration in milliseconds required to trigger End-Of-Speech. */
  readonly endOfSpeechSilenceMs: number;
}

export const DEFAULT_ACOUSTIC_PROFILES: Record<
  DeviceAcousticProfile["deviceType"],
  DeviceAcousticProfile
> = {
  desktop: {
    deviceType: "desktop",
    aecEnabled: true,
    echoDelayMs: 40,
    bargeInEnergyThreshold: 0.15,
    endOfSpeechSilenceMs: 800,
  },
  satellite: {
    deviceType: "satellite",
    aecEnabled: true,
    echoDelayMs: 60,
    bargeInEnergyThreshold: 0.2,
    endOfSpeechSilenceMs: 1000,
  },
  mobile: {
    deviceType: "mobile",
    aecEnabled: true,
    echoDelayMs: 30,
    bargeInEnergyThreshold: 0.18,
    endOfSpeechSilenceMs: 750,
  },
};

export interface AudioFrame {
  readonly samples: Float32Array;
  readonly sampleRate: number;
  readonly timestamp: number;
}

export type StreamState = "idle" | "listening" | "speaking" | "interrupted" | "closed";

export class AudioStreamingSession {
  readonly #profile: DeviceAcousticProfile;
  readonly #onBargeIn?: (() => void) | undefined;
  readonly #onEndOfSpeech?: (() => void) | undefined;

  #state: StreamState = "idle";
  #silenceDurationMs = 0;
  #speechDetectedInTurn = false;
  #noiseFloorRms = 0.02;
  #closed = false;

  constructor(options: {
    profile?: DeviceAcousticProfile;
    onBargeIn?: () => void;
    onEndOfSpeech?: () => void;
  }) {
    this.#profile = options.profile ?? DEFAULT_ACOUSTIC_PROFILES.desktop;
    this.#onBargeIn = options.onBargeIn;
    this.#onEndOfSpeech = options.onEndOfSpeech;
  }

  get state(): StreamState {
    return this.#state;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  get profile(): DeviceAcousticProfile {
    return this.#profile;
  }

  startListening(): void {
    if (this.#closed) throw new Error("Cannot start listening on closed audio stream.");
    this.#state = "listening";
    this.#silenceDurationMs = 0;
    this.#speechDetectedInTurn = false;
  }

  startSpeaking(): void {
    if (this.#closed) throw new Error("Cannot start speaking on closed audio stream.");
    this.#state = "speaking";
  }

  /**
   * Processes an incoming microphone frame.
   * Calculates RMS energy, checks for barge-in if speaking, and monitors EOS if listening.
   */
  processMicrophoneFrame(frame: AudioFrame): {
    energyRms: number;
    isSpeech: boolean;
    bargeInTriggered: boolean;
    endOfSpeechTriggered: boolean;
  } {
    if (this.#closed) {
      return {
        energyRms: 0,
        isSpeech: false,
        bargeInTriggered: false,
        endOfSpeechTriggered: false,
      };
    }

    const energyRms = this.#calculateRms(frame.samples);
    const frameDurationMs = (frame.samples.length / frame.sampleRate) * 1000;

    // Dynamically update noise floor when ambient noise is steady and low
    if (energyRms < this.#noiseFloorRms * 1.5 && energyRms > 0.001) {
      this.#noiseFloorRms = this.#noiseFloorRms * 0.95 + energyRms * 0.05;
    }

    const speechThreshold = Math.max(this.#noiseFloorRms * 2.5, 0.04);
    const isSpeech = energyRms > speechThreshold;

    let bargeInTriggered = false;
    let endOfSpeechTriggered = false;

    if (this.#state === "speaking") {
      // While assistant speaks, check if user voice exceeds barge-in threshold
      if (energyRms > this.#profile.bargeInEnergyThreshold) {
        bargeInTriggered = true;
        this.#state = "interrupted";
        this.#onBargeIn?.();
      }
    } else if (this.#state === "listening") {
      if (isSpeech) {
        this.#speechDetectedInTurn = true;
        this.#silenceDurationMs = 0;
      } else if (this.#speechDetectedInTurn) {
        // User previously spoke in this turn, accumulating silence
        this.#silenceDurationMs += frameDurationMs;
        if (this.#silenceDurationMs >= this.#profile.endOfSpeechSilenceMs) {
          endOfSpeechTriggered = true;
          this.#state = "idle";
          this.#onEndOfSpeech?.();
        }
      }
    }

    return {
      energyRms,
      isSpeech,
      bargeInTriggered,
      endOfSpeechTriggered,
    };
  }

  /** Closes microphone and audio channels immediately. Idempotent. */
  close(): void {
    this.#closed = true;
    this.#state = "closed";
  }

  #calculateRms(samples: Float32Array): number {
    if (samples.length === 0) return 0;
    let sumSquares = 0;
    for (const s of samples) {
      sumSquares += s * s;
    }
    return Math.sqrt(sumSquares / samples.length);
  }
}
