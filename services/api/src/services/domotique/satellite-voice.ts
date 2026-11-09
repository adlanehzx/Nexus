import { z } from "zod";
import {
  SatelliteVoiceSession,
  VoiceUnavailableError,
  type SatelliteAudioSink,
  type SpeechToTextPort,
  type TextToSpeechPort,
  type VoiceIntentHandler,
} from "@nexus/voice";

/**
 * Voice gateway for ESP32 satellites (protocol v1, see
 * docs/integration/esp32-voice-satellite-protocol.md).
 *
 * Transport-agnostic: the WebSocket route authenticates the device, then
 * feeds frames here. One live session per satellite; a reconnect replaces the
 * previous session. Only the satellite that spoke receives the reply audio.
 */

export const satelliteHelloSchema = z.object({
  v: z.literal(1),
  type: z.literal("hello"),
  deviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,47}$/),
  token: z.string().min(8).max(512),
  firmware: z.string().max(64).optional(),
  audio: z
    .object({
      mic: z
        .object({
          encoding: z.literal("pcm_s16le"),
          sampleRate: z.literal(16_000),
          channels: z.literal(1),
        })
        .optional(),
      speaker: z
        .object({
          encoding: z.literal("pcm_s16le"),
          sampleRate: z.union([z.literal(16_000), z.literal(22_050), z.literal(24_000)]),
          channels: z.literal(1),
        })
        .optional(),
    })
    .default({}),
});
export type SatelliteHello = z.infer<typeof satelliteHelloSchema>;

export const satelliteControlSchema = z.discriminatedUnion("type", [
  z.object({
    v: z.literal(1),
    type: z.literal("wake"),
    wakeWord: z.string().max(32).optional(),
    score: z.number().optional(),
  }),
  z.object({ v: z.literal(1), type: z.literal("audio.end") }),
  z.object({ v: z.literal(1), type: z.literal("cancel") }),
  z.object({
    v: z.literal(1),
    type: z.literal("playback.done"),
    turnId: z.string().max(80).optional(),
  }),
  z.object({ v: z.literal(1), type: z.literal("ping") }),
]);

export interface SatelliteVoiceStatus {
  readonly deviceId: string;
  readonly connected: boolean;
  readonly mic: boolean;
  readonly speaker: boolean;
  readonly speakerSampleRate: number | null;
  readonly state: string;
  readonly firmware: string | null;
  readonly connectedAt: string | null;
  readonly lastTurnAt: string | null;
  readonly turns: number;
}

interface Connection {
  session: SatelliteVoiceSession;
  sink: SatelliteAudioSink;
  hello: SatelliteHello;
  connectedAt: string;
  lastTurnAt: string | null;
  turns: number;
}

const unavailableStt: SpeechToTextPort = {
  transcribe: () =>
    Promise.reject(
      new VoiceUnavailableError(
        "speech-to-text not configured",
        "Set NEXUS_SATELLITE_WHISPER_MODEL to a whisper.cpp model on the NEXUS host.",
      ),
    ),
};

export interface SatelliteVoiceGatewayOptions {
  readonly stt?: SpeechToTextPort | undefined;
  readonly tts?: TextToSpeechPort | undefined;
  readonly intent: VoiceIntentHandler;
  readonly now?: () => Date;
  readonly onError?: (error: unknown, deviceId: string) => void;
}

export class SatelliteVoiceGateway {
  readonly #o: SatelliteVoiceGatewayOptions;
  readonly #connections = new Map<string, Connection>();
  readonly #now: () => Date;

  constructor(options: SatelliteVoiceGatewayOptions) {
    this.#o = options;
    this.#now = options.now ?? (() => new Date());
  }

  get sttConfigured(): boolean {
    return this.#o.stt !== undefined;
  }

  get ttsConfigured(): boolean {
    return this.#o.tts !== undefined;
  }

  /** Opens (or replaces) the session of an authenticated satellite. */
  attach(hello: SatelliteHello, sink: SatelliteAudioSink): SatelliteVoiceSession {
    this.#connections.get(hello.deviceId)?.session.cancel();
    const speaker = hello.audio.speaker;
    const connection: Connection = {
      hello,
      sink,
      connectedAt: this.#now().toISOString(),
      lastTurnAt: null,
      turns: 0,
      session: undefined as unknown as SatelliteVoiceSession,
    };
    connection.session = new SatelliteVoiceSession({
      satelliteId: hello.deviceId,
      sink,
      stt: this.#o.stt ?? unavailableStt,
      tts: this.#o.tts,
      intent: this.#o.intent,
      speaker: speaker === undefined ? undefined : { sampleRate: speaker.sampleRate },
      onError: (error) => this.#o.onError?.(error, hello.deviceId),
      onTurn: () => {
        connection.turns += 1;
        connection.lastTurnAt = this.#now().toISOString();
      },
    });
    this.#connections.set(hello.deviceId, connection);
    sink.sendJson({
      v: 1,
      type: "ready",
      deviceId: hello.deviceId,
      stt: this.sttConfigured,
      tts: this.ttsConfigured && speaker !== undefined,
      mic: { encoding: "pcm_s16le", sampleRate: 16_000, channels: 1 },
      ...(speaker === undefined ? {} : { speaker }),
    });
    return connection.session;
  }

  /** Detaches only if `sink` is still the current connection (a reconnect may have replaced it). */
  detach(deviceId: string, sink: SatelliteAudioSink): void {
    const connection = this.#connections.get(deviceId);
    if (connection?.sink !== sink) return;
    connection.session.cancel();
    this.#connections.delete(deviceId);
  }

  /** Handles a JSON control frame. Returns false for unknown frames. */
  control(deviceId: string, frame: unknown): boolean {
    const connection = this.#connections.get(deviceId);
    const parsed = satelliteControlSchema.safeParse(frame);
    if (connection === undefined || !parsed.success) return false;
    const message = parsed.data;
    switch (message.type) {
      case "wake":
        connection.session.wake();
        break;
      case "audio.end":
        void connection.session.endUtterance();
        break;
      case "cancel":
        connection.session.cancel();
        break;
      case "playback.done":
        break;
      case "ping":
        connection.sink.sendJson({ v: 1, type: "pong" });
        break;
    }
    return true;
  }

  audio(deviceId: string, chunk: Uint8Array): void {
    void this.#connections.get(deviceId)?.session.pushAudio(chunk);
  }

  /** Satellites with a live voice socket (they may not have sent a heartbeat yet). */
  connectedIds(): string[] {
    return [...this.#connections.keys()];
  }

  status(deviceId: string): { connected: boolean; speaker: boolean } | undefined {
    const connection = this.#connections.get(deviceId);
    if (connection === undefined) return undefined;
    return { connected: true, speaker: connection.hello.audio.speaker !== undefined };
  }

  details(deviceId: string): SatelliteVoiceStatus {
    const c = this.#connections.get(deviceId);
    return {
      deviceId,
      connected: c !== undefined,
      mic: c?.hello.audio.mic !== undefined || c !== undefined,
      speaker: c?.hello.audio.speaker !== undefined,
      speakerSampleRate: c?.hello.audio.speaker?.sampleRate ?? null,
      state: c?.session.state ?? "offline",
      firmware: c?.hello.firmware ?? null,
      connectedAt: c?.connectedAt ?? null,
      lastTurnAt: c?.lastTurnAt ?? null,
      turns: c?.turns ?? 0,
    };
  }

  /** Speaks text on a satellite's speaker. False when not connected or no speaker. */
  async say(deviceId: string, text: string): Promise<boolean> {
    const connection = this.#connections.get(deviceId);
    if (!connection?.session.hasSpeaker) return false;
    return connection.session.say(text);
  }
}
