import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import type { ProcessPort } from "./ports.js";
import type { AudioScratch } from "./scratch.js";
import { AudioStreamingSession, DEFAULT_ACOUSTIC_PROFILES } from "./streaming.js";
import { cleanTranscript, VoiceUnavailableError } from "./whisper.js";

/**
 * Remote voice pipeline for ESP32 satellites.
 *
 *     wake word (on device) → mic PCM stream → whisper STT → intent (NEXUS)
 *        → Piper TTS → PCM stream back to *that* satellite's speaker
 *
 * Desktop dictation (`WhisperDictation`, `PiperSpeech`) records and plays on
 * the host. A satellite instead *sends* its microphone and *receives* speech,
 * so this module works on buffers: the transport (WebSocket in the API) hands
 * frames in, and gets frames out through a `SatelliteAudioSink`.
 *
 * Audio formats (see docs/integration/esp32-voice-satellite-protocol.md):
 * - microphone in: PCM signed 16-bit little-endian, mono, 16 kHz;
 * - speaker out: PCM s16le mono at the rate the satellite declared
 *   (default 16 kHz); Piper's native 22.05 kHz output is resampled.
 *
 * Privacy: utterance audio lives in memory for the duration of one turn and
 * is dropped afterwards. The STT adapter writes a temporary WAV only through
 * `AudioScratch`, which verifies deletion.
 */

export interface PcmFormat {
  readonly sampleRate: number;
  readonly channels: 1;
  readonly encoding: "pcm_s16le";
}

export const SATELLITE_MIC_FORMAT: PcmFormat = {
  sampleRate: 16_000,
  channels: 1,
  encoding: "pcm_s16le",
};

export interface SpeechToTextPort {
  transcribe(pcm: Uint8Array, format: PcmFormat): Promise<string>;
}

export interface TextToSpeechPort {
  synthesize(text: string): Promise<{ pcm: Uint8Array; sampleRate: number }>;
}

/** Outbound side of a satellite connection. */
export interface SatelliteAudioSink {
  sendJson(message: Record<string, unknown>): void;
  sendAudio(chunk: Uint8Array): void;
}

export interface VoiceIntentHandler {
  handle(input: { satelliteId: string; text: string }): Promise<{ reply: string }>;
}

export type SatelliteVoiceState = "idle" | "listening" | "processing" | "speaking";

export interface SatelliteVoiceSessionOptions {
  readonly satelliteId: string;
  readonly sink: SatelliteAudioSink;
  readonly stt: SpeechToTextPort;
  readonly tts?: TextToSpeechPort | undefined;
  readonly intent: VoiceIntentHandler;
  /** Speaker declared by the satellite. Absent = text-only replies. */
  readonly speaker?: { readonly sampleRate: number } | undefined;
  readonly micFormat?: PcmFormat;
  /** Hard cap on one utterance. */
  readonly maxUtteranceMs?: number;
  /** Outbound audio chunk size in bytes (even). */
  readonly chunkBytes?: number;
  /** Server-side end-of-speech detection on top of the device's `audio.end`. */
  readonly serverEndOfSpeech?: boolean;
  readonly newId?: () => string;
  readonly onError?: (error: unknown) => void;
  readonly onTurn?: (turn: { transcript: string; reply: string; spoken: boolean }) => void;
}

/** One satellite's voice turn state machine. Never more than one turn at a time. */
export class SatelliteVoiceSession {
  readonly #o: SatelliteVoiceSessionOptions;
  readonly #mic: PcmFormat;
  readonly #maxBytes: number;
  readonly #chunkBytes: number;
  #state: SatelliteVoiceState = "idle";
  #turnId: string | null = null;
  #buffers: Uint8Array[] = [];
  #bytes = 0;
  #eos: AudioStreamingSession | undefined;
  #cancelled = false;
  #counter = 0;

  constructor(options: SatelliteVoiceSessionOptions) {
    this.#o = options;
    this.#mic = options.micFormat ?? SATELLITE_MIC_FORMAT;
    const maxMs = options.maxUtteranceMs ?? 15_000;
    this.#maxBytes = Math.floor((this.#mic.sampleRate * 2 * maxMs) / 1000);
    this.#chunkBytes = Math.max(2, (options.chunkBytes ?? 4_096) & ~1);
  }

  get state(): SatelliteVoiceState {
    return this.#state;
  }

  get turnId(): string | null {
    return this.#turnId;
  }

  get hasSpeaker(): boolean {
    return this.#o.speaker !== undefined && this.#o.tts !== undefined;
  }

  /** Wake word detected on the device: open a turn. A wake during playback interrupts it. */
  wake(): string {
    this.#cancelled = this.#state === "speaking" || this.#state === "processing";
    this.#counter += 1;
    this.#turnId = this.#o.newId?.() ?? `turn-${String(Date.now())}-${String(this.#counter)}`;
    this.#buffers = [];
    this.#bytes = 0;
    this.#state = "listening";
    if (this.#o.serverEndOfSpeech !== false) {
      this.#eos = new AudioStreamingSession({ profile: DEFAULT_ACOUSTIC_PROFILES.satellite });
      this.#eos.startListening();
    }
    this.#o.sink.sendJson({ v: 1, type: "listening", turnId: this.#turnId });
    return this.#turnId;
  }

  /**
   * Microphone chunk. Ignored outside a listening turn: the device must not
   * stream ambient audio, and if it does, nothing is kept.
   */
  pushAudio(chunk: Uint8Array): Promise<void> | undefined {
    if (this.#state !== "listening") return undefined;
    const usable = chunk.byteLength & ~1;
    if (usable === 0) return undefined;
    const room = this.#maxBytes - this.#bytes;
    const slice = chunk.subarray(0, Math.min(usable, room));
    this.#buffers.push(slice);
    this.#bytes += slice.byteLength;
    if (this.#bytes >= this.#maxBytes) return this.endUtterance();
    if (this.#eos !== undefined) {
      const frame = this.#eos.processMicrophoneFrame({
        samples: pcm16ToFloat32(slice),
        sampleRate: this.#mic.sampleRate,
        timestamp: Date.now(),
      });
      if (frame.endOfSpeechTriggered) return this.endUtterance();
    }
    return undefined;
  }

  /** End of utterance (device VAD, server EOS, or length cap): run STT → intent → TTS. */
  async endUtterance(): Promise<void> {
    if (this.#state !== "listening") return;
    this.#state = "processing";
    this.#cancelled = false;
    const turnId = this.#turnId;
    const audio = concat(this.#buffers, this.#bytes);
    this.#buffers = [];
    this.#bytes = 0;
    this.#eos?.close();
    this.#eos = undefined;
    try {
      const transcript =
        audio.byteLength < this.#mic.sampleRate * 2 * 0.2
          ? ""
          : (await this.#o.stt.transcribe(audio, this.#mic)).trim();
      if (this.#stale(turnId)) return;
      this.#o.sink.sendJson({ v: 1, type: "transcript", turnId, text: transcript });
      const reply =
        transcript.length === 0
          ? "Je n'ai rien entendu."
          : (await this.#o.intent.handle({ satelliteId: this.#o.satelliteId, text: transcript }))
              .reply;
      if (this.#stale(turnId)) return;
      this.#o.sink.sendJson({ v: 1, type: "reply", turnId, text: reply });
      const spoken = await this.#speak(turnId, reply);
      this.#o.onTurn?.({ transcript, reply, spoken });
    } catch (error) {
      this.#o.onError?.(error);
      this.#o.sink.sendJson({
        v: 1,
        type: "error",
        turnId,
        code: error instanceof VoiceUnavailableError ? "VOICE_UNAVAILABLE" : "TURN_FAILED",
        message: "The voice request could not be processed.",
      });
    } finally {
      if (this.#turnId === turnId) this.#state = "idle";
    }
  }

  /** Speaks arbitrary text on this satellite (e.g. a `speak` device action). */
  async say(text: string): Promise<boolean> {
    if (this.#state === "listening" || this.#state === "processing") return false;
    this.#counter += 1;
    const turnId = this.#o.newId?.() ?? `say-${String(Date.now())}-${String(this.#counter)}`;
    this.#turnId = turnId;
    this.#cancelled = false;
    try {
      this.#o.sink.sendJson({ v: 1, type: "reply", turnId, text });
      return await this.#speak(turnId, text);
    } finally {
      if (this.#turnId === turnId) this.#state = "idle";
    }
  }

  /** Device cancelled (button, barge-in) or disconnected. */
  cancel(): void {
    this.#cancelled = true;
    this.#buffers = [];
    this.#bytes = 0;
    this.#eos?.close();
    this.#eos = undefined;
    this.#state = "idle";
  }

  #stale(turnId: string | null): boolean {
    return this.#cancelled || this.#turnId !== turnId;
  }

  async #speak(turnId: string | null, text: string): Promise<boolean> {
    const speaker = this.#o.speaker;
    const tts = this.#o.tts;
    if (speaker === undefined || tts === undefined || text.trim().length === 0) return false;
    this.#state = "speaking";
    const synthesized = await tts.synthesize(text);
    if (this.#stale(turnId)) return false;
    const pcm = resamplePcm16(synthesized.pcm, synthesized.sampleRate, speaker.sampleRate);
    this.#o.sink.sendJson({
      v: 1,
      type: "tts.start",
      turnId,
      encoding: "pcm_s16le",
      sampleRate: speaker.sampleRate,
      channels: 1,
      bytes: pcm.byteLength,
    });
    for (let offset = 0; offset < pcm.byteLength; offset += this.#chunkBytes) {
      if (this.#cancelled) {
        this.#o.sink.sendJson({ v: 1, type: "tts.end", turnId, interrupted: true });
        return false;
      }
      this.#o.sink.sendAudio(pcm.subarray(offset, offset + this.#chunkBytes));
    }
    this.#o.sink.sendJson({ v: 1, type: "tts.end", turnId, interrupted: false });
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PCM helpers
// ─────────────────────────────────────────────────────────────────────────────

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function pcm16ToFloat32(pcm: Uint8Array): Float32Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength & ~1);
  const out = new Float32Array(view.byteLength / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = view.getInt16(i * 2, true) / 32_768;
  return out;
}

/** Linear-interpolation resampler for mono PCM s16le. Good enough for speech. */
export function resamplePcm16(pcm: Uint8Array, fromRate: number, toRate: number): Uint8Array {
  if (fromRate === toRate) return pcm;
  const input = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength & ~1);
  const inSamples = input.byteLength / 2;
  if (inSamples === 0) return new Uint8Array(0);
  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate));
  const out = new Uint8Array(outSamples * 2);
  const output = new DataView(out.buffer);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outSamples; i += 1) {
    const pos = i * ratio;
    const left = Math.min(inSamples - 1, Math.floor(pos));
    const right = Math.min(inSamples - 1, left + 1);
    const frac = pos - left;
    const value =
      input.getInt16(left * 2, true) * (1 - frac) + input.getInt16(right * 2, true) * frac;
    output.setInt16(i * 2, Math.max(-32_768, Math.min(32_767, Math.round(value))), true);
  }
  return out;
}

/** Wraps raw PCM s16le mono in a 44-byte RIFF/WAVE header. */
export function wavFromPcm16(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = new DataView(new ArrayBuffer(44));
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) header.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  header.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  ascii(36, "data");
  header.setUint32(40, pcm.byteLength, true);
  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(new Uint8Array(header.buffer), 0);
  out.set(pcm, 44);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Production adapters (whisper.cpp, Piper)
// ─────────────────────────────────────────────────────────────────────────────

export interface WhisperBufferOptions {
  readonly process: ProcessPort;
  readonly scratch: AudioScratch;
  readonly modelPath: string;
  readonly binary?: string;
  readonly language?: string;
  /** Writes the temporary WAV. Defaults to an owner-only file. */
  readonly writeBinary?: (path: string, data: Uint8Array) => Promise<void>;
}

/** whisper.cpp over a temporary WAV that `AudioScratch` deletes and verifies. */
export class WhisperBufferTranscriber implements SpeechToTextPort {
  readonly #o: WhisperBufferOptions;

  constructor(options: WhisperBufferOptions) {
    this.#o = options;
  }

  async transcribe(pcm: Uint8Array, format: PcmFormat): Promise<string> {
    const binary = this.#o.binary ?? "whisper-cli";
    if ((await this.#o.process.which(binary)) === undefined) {
      throw new VoiceUnavailableError(
        `binary ${binary} missing`,
        "Install whisper.cpp on the NEXUS host.",
      );
    }
    const write =
      this.#o.writeBinary ??
      ((path: string, data: Uint8Array) => writeFile(path, data, { mode: 0o600 }));
    return this.#o.scratch.withAudio(async (path) => {
      await write(path, wavFromPcm16(pcm, format.sampleRate));
      const run = this.#o.process.spawn(binary, [
        "-m",
        this.#o.modelPath,
        "-f",
        path,
        "--no-timestamps",
        ...(this.#o.language === undefined ? [] : ["-l", this.#o.language]),
      ]);
      if ((await run.exit()) !== 0) return "";
      return cleanTranscript(await run.output());
    });
  }
}

export interface PiperBufferOptions {
  readonly modelPath: string;
  readonly binary?: string;
  /** Model sample rate (Piper `.onnx.json` → audio.sample_rate). */
  readonly sampleRate?: number;
  readonly lengthScale?: number;
  readonly timeoutMs?: number;
}

/** Piper `--output_raw` captured to memory (no player, no file). */
export class PiperBufferSynthesizer implements TextToSpeechPort {
  readonly #o: PiperBufferOptions;

  constructor(options: PiperBufferOptions) {
    this.#o = options;
  }

  synthesize(text: string): Promise<{ pcm: Uint8Array; sampleRate: number }> {
    const args = [
      "--model",
      this.#o.modelPath,
      "--output_raw",
      ...(this.#o.lengthScale === undefined ? [] : ["--length_scale", String(this.#o.lengthScale)]),
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.#o.binary ?? "piper", args, { stdio: ["pipe", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => child.kill("SIGKILL"), this.#o.timeoutMs ?? 30_000);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        // 60 s of 22.05 kHz audio is far beyond any spoken reply.
        if (size > 3_000_000) child.kill("SIGKILL");
        else chunks.push(chunk);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new VoiceUnavailableError(error.message, "Install Piper on the NEXUS host."));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new VoiceUnavailableError(
              `piper exited with ${String(code)}`,
              "Check the Piper voice model path.",
            ),
          );
          return;
        }
        resolve({
          pcm: new Uint8Array(Buffer.concat(chunks)),
          sampleRate: this.#o.sampleRate ?? 22_050,
        });
      });
      child.stdin.end(text, "utf8");
    });
  }
}
