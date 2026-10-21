import type { ProcessPort, SpawnedProcess } from "./ports.js";
import { VoiceUnavailableError } from "./whisper.js";

/**
 * Local text-to-speech synthesis powered by Piper.
 *
 * ## Why local synthesis
 *
 * Text-to-speech synthesis delivers spoken responses containing private emails,
 * messages, or personal calendar items. Using on-device synthesis keeps these
 * outputs local without shipping them to external synthesis APIs.
 *
 * ## Pipeline
 *
 *     text -> piper (stdin) -> raw audio (stdout) -> audio player (stdin)
 *
 * Piper streams directly into the player via pipes without temporary files on disk.
 *
 * ## Interruptibility
 *
 * Uninterruptible voice output harms conversational usability. `stop()` terminates
 * both the synthesizer and audio player immediately, and `interrupted` indicates
 * whether output was cancelled early.
 */

export interface PiperOptions {
  process: ProcessPort;
  binary?: string;
  /** Voice model `.onnx` file path. */
  modelPath: string;
  /** Audio player reading raw PCM stream from standard input. */
  player?: { command: string; args: readonly string[] };
  /** Phoneme length scale (smaller = faster). */
  lengthScale?: number;
}

/** `aplay` accompanies ALSA on standard Linux distributions. */
const DEFAULT_PLAYER = {
  command: "aplay",
  // Format produced by Piper: 16-bit, mono, 22.05 kHz.
  args: ["-q", "-r", "22050", "-f", "S16_LE", "-t", "raw", "-"],
};

export class PiperSpeech {
  readonly #process: ProcessPort;
  readonly #binary: string;
  readonly #modelPath: string;
  readonly #player: { command: string; args: readonly string[] };
  readonly #lengthScale: number | undefined;

  #synthesis: SpawnedProcess | undefined;
  #playback: SpawnedProcess | undefined;
  #interrupted = false;

  constructor(options: PiperOptions) {
    this.#process = options.process;
    this.#binary = options.binary ?? "piper";
    this.#modelPath = options.modelPath;
    this.#player = options.player ?? DEFAULT_PLAYER;
    this.#lengthScale = options.lengthScale;
  }

  get speaking(): boolean {
    return this.#synthesis !== undefined || this.#playback !== undefined;
  }

  /** Indicates whether the previous speech was interrupted. */
  get interrupted(): boolean {
    return this.#interrupted;
  }

  async availability(): Promise<{ ok: boolean; reason?: string; remedy?: string }> {
    if ((await this.#process.which(this.#binary)) === undefined) {
      return {
        ok: false,
        reason: `binary ${this.#binary} missing`,
        remedy: `Install Piper, then verify "${this.#binary}" is in PATH.`,
      };
    }
    if ((await this.#process.which(this.#player.command)) === undefined) {
      return {
        ok: false,
        reason: `player ${this.#player.command} missing`,
        remedy: `Install "${this.#player.command}" to play audio.`,
      };
    }
    return { ok: true };
  }

  async isAvailable(): Promise<boolean> {
    return (await this.availability()).ok;
  }

  /**
   * Synthesizes and speaks text. Resolves upon completion or interruption.
   */
  async speak(text: string): Promise<{ interrupted: boolean }> {
    const available = await this.availability();
    if (!available.ok) {
      throw new VoiceUnavailableError(available.reason ?? "unknown", available.remedy ?? "");
    }
    // A new utterance cancels any in-progress speech.
    await this.stop();
    this.#interrupted = false;

    const args = [
      "--model",
      this.#modelPath,
      "--output_raw",
      ...(this.#lengthScale === undefined ? [] : ["--length_scale", String(this.#lengthScale)]),
    ];

    const synthesis = this.#process.spawn(this.#binary, args, text);
    const playback = this.#process.spawn(this.#player.command, this.#player.args);
    this.#synthesis = synthesis;
    this.#playback = playback;

    try {
      await synthesis.exit();
      await playback.exit();
    } finally {
      if (this.#synthesis === synthesis) {
        this.#synthesis = undefined;
        this.#playback = undefined;
      }
    }
    return { interrupted: this.#interrupted };
  }

  /**
   * Immediately stops speech and terminates player and synthesis processes.
   */
  async stop(): Promise<void> {
    if (!this.speaking) return;
    this.#interrupted = true;
    this.#synthesis?.kill();
    this.#playback?.kill();
    this.#synthesis = undefined;
    this.#playback = undefined;
    await Promise.resolve();
  }
}
