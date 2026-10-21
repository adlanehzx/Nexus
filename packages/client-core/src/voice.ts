import { AppError, type ErrorSeverity } from "@nexus/shared";
import type { SpeechToTextProvider, TextToSpeechProvider } from "./ports.js";

/**
 * Voice pipeline.
 *
 *     microphone (press) → recognition → text → NEXUS → response → (speech)
 *
 * **There is no always-on listening.** Speech-to-text ports only expose `start`, `stop`, and `cancel`.
 * An API without continuous listening capabilities cannot be inadvertently misused.
 *
 * Three core rules:
 *  1. Listening starts only on explicit user action, never automatically;
 *  2. Listening stops on release or duration timeout;
 *  3. Cancellation discards the transcription without sending.
 *
 * Text-to-speech output is optional and disabled by default.
 */

export class MicrophoneUnavailableError extends AppError {
  readonly code = "MICROPHONE_UNAVAILABLE";
  readonly httpStatus = 403;
  override readonly severity: ErrorSeverity = "warning";

  constructor(reason: string) {
    super({
      message: `Microphone unavailable: ${reason}`,
      userMessage:
        "NEXUS has no access to the microphone. Allow it in Settings → NEXUS → Microphone.",
      context: { reason },
    });
  }
}

export type VoiceState = "idle" | "listening" | "transcribing" | "speaking";

export interface VoicePipelineOptions {
  speechToText: SpeechToTextProvider;
  textToSpeech: TextToSpeechProvider;
  /** Maximum listening duration in milliseconds before automatic cutoff. */
  maxListeningMs?: number;
  locale?: string;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onStateChange?: (state: VoiceState) => void;
  onPartial?: (text: string) => void;
}

export class VoicePipeline {
  readonly #stt: SpeechToTextProvider;
  readonly #tts: TextToSpeechProvider;
  readonly #maxListeningMs: number;
  readonly #locale: string | undefined;
  readonly #setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #onStateChange: ((state: VoiceState) => void) | undefined;
  readonly #onPartial: ((text: string) => void) | undefined;

  #state: VoiceState = "idle";
  #guardHandle: unknown;

  /** Speaking replies aloud is a user choice, disabled by default. */
  #speakReplies = false;

  constructor(options: VoicePipelineOptions) {
    this.#stt = options.speechToText;
    this.#tts = options.textToSpeech;
    this.#maxListeningMs = options.maxListeningMs ?? 30_000;
    this.#locale = options.locale;
    this.#setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.#clearTimer =
      options.clearTimer ??
      ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      });
    this.#onStateChange = options.onStateChange;
    this.#onPartial = options.onPartial;
  }

  get state(): VoiceState {
    return this.#state;
  }

  get isListening(): boolean {
    return this.#state === "listening";
  }

  get speakRepliesEnabled(): boolean {
    return this.#speakReplies;
  }

  setSpeakReplies(enabled: boolean): void {
    this.#speakReplies = enabled;
  }

  /** Checks whether the platform supports speech transcription. */
  isSpeechAvailable(): Promise<boolean> {
    return this.#stt.isAvailable();
  }

  /**
   * Starts listening upon explicit user action.
   *
   * @throws {MicrophoneUnavailableError} if hardware is missing or permission is denied.
   */
  async startListening(): Promise<void> {
    if (this.#state === "listening") return;

    if (!(await this.#stt.isAvailable())) {
      throw new MicrophoneUnavailableError("speech recognition unavailable");
    }
    if (!(await this.#stt.requestPermission())) {
      throw new MicrophoneUnavailableError("permission denied");
    }

    await this.#stt.start({
      ...(this.#locale === undefined ? {} : { locale: this.#locale }),
      ...(this.#onPartial === undefined ? {} : { onPartial: this.#onPartial }),
    });

    this.#setState("listening");

    // Safety timeout: prevents microphone staying open if screen locks or app suspends.
    this.#guardHandle = this.#setTimer(() => {
      void this.cancelListening();
    }, this.#maxListeningMs);
  }

  /**
   * Stops listening and returns recognized text.
   *
   * Returns `undefined` if nothing actionable was transcribed.
   */
  async stopListening(): Promise<string | undefined> {
    if (this.#state !== "listening") return undefined;

    this.#clearGuard();
    this.#setState("transcribing");

    try {
      const result = await this.#stt.stop();
      const text = result.text.trim();

      return text.length === 0 ? undefined : text;
    } finally {
      this.#setState("idle");
    }
  }

  /** Cancels listening and discards partial transcription. */
  async cancelListening(): Promise<void> {
    if (this.#state !== "listening") return;

    this.#clearGuard();
    await this.#stt.cancel().catch(() => undefined);
    this.#setState("idle");
  }

  /** Speaks response text aloud if enabled by user preferences. */
  async speak(text: string): Promise<boolean> {
    if (!this.#speakReplies) return false;
    if (!(await this.#tts.isAvailable())) return false;

    this.#setState("speaking");
    try {
      await this.#tts.speak(text, {
        ...(this.#locale === undefined ? {} : { locale: this.#locale }),
      });
      return true;
    } catch {
      return false;
    } finally {
      this.#setState("idle");
    }
  }

  /** Interrupts speech playback when user speaks. */
  async stopSpeaking(): Promise<void> {
    await this.#tts.stop().catch(() => undefined);
    if (this.#state === "speaking") this.#setState("idle");
  }

  #clearGuard(): void {
    if (this.#guardHandle === undefined) return;
    this.#clearTimer(this.#guardHandle);
    this.#guardHandle = undefined;
  }

  #setState(state: VoiceState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#onStateChange?.(state);
  }
}
