import { AppError } from "@nexus/shared";
import type { ClockPort, FilePort, ProcessPort, SpawnedProcess } from "./ports.js";
import type { AudioScratch } from "./scratch.js";

/**
 * Local dictation powered by whisper.cpp.
 *
 * ## Why local whisper.cpp instead of a cloud API
 *
 * Dictation captures everything spoken aloud in a private room. Cloud speech-to-text
 * APIs receive raw room audio, the most sensitive data an assistant touches —
 * even when words were not directed at the assistant. Running whisper.cpp on-device
 * requires no account, no API key, and no outbound network access.
 *
 * ## Pipeline lifecycle
 *
 *     microphone (recorder) -> temporary WAV -> whisper.cpp -> text
 *                                    ^
 *                          deleted, deletion verified
 *
 * Two child processes require explicit lifecycle management: a recorder process
 * that must be terminated upon stop, and a temporary WAV file that must never survive errors.
 *
 * ## Streaming and partial transcripts
 *
 * Partial transcriptions are emitted per segment: the recording is split into time
 * segments, each transcribed when closed, and `onPartial` is called progressively.
 */

export class VoiceUnavailableError extends AppError {
  readonly code = "VOICE_UNAVAILABLE";
  readonly httpStatus = 503;

  constructor(reason: string, remedy: string) {
    super({
      message: `dictation unavailable: ${reason}`,
      userMessage: remedy,
      context: { reason },
    });
  }
}

export interface TranscriptionResult {
  text: string;
  /** Transcribed segments in chronological order. */
  segments: readonly string[];
  durationMs: number;
}

export interface WhisperOptions {
  process: ProcessPort;
  files: FilePort;
  clock: ClockPort;
  scratch: AudioScratch;
  /** whisper.cpp binary. Usually `whisper-cli`. */
  binary?: string;
  /** Path to `.bin` model file. */
  modelPath: string;
  /**
   * Recording command. Must write WAV to target path and terminate upon signal.
   */
  recorder?: { command: string; args: (path: string) => readonly string[] };
  language?: string;
  /** Segment duration for progressive transcriptions. */
  segmentMs?: number;
  /** Maximum listening duration guardrail. */
  maxListeningMs?: number;
}

/** `arecord` is standard on ALSA Linux systems. */
const DEFAULT_RECORDER = {
  command: "arecord",
  args: (path: string) => ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", path],
};

export class WhisperDictation {
  readonly #process: ProcessPort;
  readonly #files: FilePort;
  readonly #clock: ClockPort;
  readonly #scratch: AudioScratch;
  readonly #binary: string;
  readonly #modelPath: string;
  readonly #recorder: { command: string; args: (path: string) => readonly string[] };
  readonly #language: string | undefined;
  readonly #segmentMs: number;
  readonly #maxListeningMs: number;

  #recording: SpawnedProcess | undefined;
  #cancelled = false;
  #segments: string[] = [];
  #startedAt = 0;

  constructor(options: WhisperOptions) {
    this.#process = options.process;
    this.#files = options.files;
    this.#clock = options.clock;
    this.#scratch = options.scratch;
    this.#binary = options.binary ?? "whisper-cli";
    this.#modelPath = options.modelPath;
    this.#recorder = options.recorder ?? DEFAULT_RECORDER;
    this.#language = options.language;
    this.#segmentMs = options.segmentMs ?? 2_000;
    this.#maxListeningMs = options.maxListeningMs ?? 30_000;
  }

  get listening(): boolean {
    return this.#recording !== undefined;
  }

  /**
   * Checks dependencies and files required for local dictation.
   */
  async availability(): Promise<{ ok: boolean; reason?: string; remedy?: string }> {
    if ((await this.#process.which(this.#binary)) === undefined) {
      return {
        ok: false,
        reason: `binary ${this.#binary} missing`,
        remedy: `Install whisper.cpp, then verify "${this.#binary}" is in PATH.`,
      };
    }
    if (!(await this.#files.exists(this.#modelPath))) {
      return {
        ok: false,
        reason: `model missing: ${this.#modelPath}`,
        remedy: `Download a whisper model and place it at ${this.#modelPath}.`,
      };
    }
    if ((await this.#process.which(this.#recorder.command)) === undefined) {
      return {
        ok: false,
        reason: `recorder ${this.#recorder.command} missing`,
        remedy: `Install "${this.#recorder.command}" to capture microphone input.`,
      };
    }
    return { ok: true };
  }

  async isAvailable(): Promise<boolean> {
    return (await this.availability()).ok;
  }

  /**
   * Starts listening upon explicit user action.
   */
  async start(options: { onPartial?: (text: string) => void } = {}): Promise<void> {
    if (this.#recording !== undefined) return;
    const available = await this.availability();
    if (!available.ok) {
      throw new VoiceUnavailableError(available.reason ?? "unknown", available.remedy ?? "");
    }

    this.#cancelled = false;
    this.#segments = [];
    this.#startedAt = this.#clock.now();

    await this.#scratch.withAudio(async (path) => {
      this.#recording = this.#process.spawn(this.#recorder.command, this.#recorder.args(path));
      await this.#segmentLoop(path, options.onPartial);
    });
  }

  async #segmentLoop(path: string, onPartial?: (text: string) => void): Promise<void> {
    while (this.#recording !== undefined && !this.#cancelled) {
      await this.#clock.sleep(this.#segmentMs);
      if (this.#recording === undefined || this.#cancelled) break;

      if (this.#clock.now() - this.#startedAt >= this.#maxListeningMs) {
        this.#stopRecorder();
        break;
      }

      const transcript = await this.#transcribe(path);
      if (transcript.length > 0 && transcript !== this.#segments.at(-1)) {
        this.#segments = [transcript];
        onPartial?.(transcript);
      }
    }
  }

  /**
   * Stops listening and returns transcription result.
   */
  stop(): Promise<TranscriptionResult> {
    const durationMs = this.#clock.now() - this.#startedAt;
    this.#stopRecorder();
    return Promise.resolve({
      text: this.#segments.join(" ").trim(),
      segments: [...this.#segments],
      durationMs,
    });
  }

  /**
   * Cancels listening and discards buffered transcription.
   */
  async cancel(): Promise<void> {
    this.#cancelled = true;
    this.#segments = [];
    this.#stopRecorder();
    await Promise.resolve();
  }

  #stopRecorder(): void {
    this.#recording?.kill();
    this.#recording = undefined;
  }

  async #transcribe(path: string): Promise<string> {
    const size = await this.#files.size(path);
    if (size === undefined || size <= 44) return "";

    const args = [
      "-m",
      this.#modelPath,
      "-f",
      path,
      "--no-timestamps",
      ...(this.#language === undefined ? [] : ["-l", this.#language]),
    ];
    const run = this.#process.spawn(this.#binary, args);
    const code = await run.exit();
    if (code !== 0) return "";
    return cleanTranscript(await run.output());
  }
}

/**
 * Strips diagnostic output and noise markers from whisper.cpp output.
 */
export function cleanTranscript(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("whisper_") && !line.startsWith("["))
    .map((line) =>
      line.replace(/\((?:silence|musique|rires|bruit|music|laughter|noise)\)/gi, "").trim(),
    )
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
