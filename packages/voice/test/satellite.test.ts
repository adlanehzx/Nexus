import { describe, expect, it, vi } from "vitest";
import {
  AudioScratch,
  SatelliteVoiceSession,
  WhisperBufferTranscriber,
  resamplePcm16,
  wavFromPcm16,
  type SatelliteAudioSink,
} from "../src/index.js";
import { FakeFiles, FakeProcess } from "./fakes.js";

class RecordingSink implements SatelliteAudioSink {
  readonly json: Record<string, unknown>[] = [];
  readonly audio: Uint8Array[] = [];
  sendJson(message: Record<string, unknown>): void {
    this.json.push(message);
  }
  sendAudio(chunk: Uint8Array): void {
    this.audio.push(chunk);
  }
  types(): unknown[] {
    return this.json.map((m) => m.type);
  }
}

/** 16 kHz PCM s16le with a 440 Hz tone (speech-like energy). */
function tone(ms: number, amplitude = 8_000): Uint8Array {
  const samples = Math.round((16_000 * ms) / 1000);
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i += 1) {
    view.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / 16_000) * amplitude), true);
  }
  return out;
}

function makeTts(sampleRate = 22_050, samples = 22_050) {
  return {
    synthesize: vi.fn((_text: string) =>
      Promise.resolve({ pcm: new Uint8Array(samples * 2).fill(1), sampleRate }),
    ),
  };
}

describe("SatelliteVoiceSession", () => {
  it("runs wake → audio → STT → intent → TTS and streams speech back to the speaker", async () => {
    const sink = new RecordingSink();
    const stt = { transcribe: vi.fn(() => Promise.resolve("allume la lampe du salon")) };
    const intent = { handle: vi.fn(() => Promise.resolve({ reply: "Lampe salon allumée." })) };
    const tts = makeTts();
    const session = new SatelliteVoiceSession({
      satelliteId: "esp32-salon",
      sink,
      stt,
      tts,
      intent,
      speaker: { sampleRate: 16_000 },
      serverEndOfSpeech: false,
      chunkBytes: 4_000,
      newId: () => "turn-1",
    });

    expect(session.wake()).toBe("turn-1");
    for (let i = 0; i < 10; i += 1) void session.pushAudio(tone(100));
    await session.endUtterance();

    const [audio, format] = stt.transcribe.mock.calls[0] as unknown as [
      Uint8Array,
      { sampleRate: number },
    ];
    expect(audio.byteLength).toBe(32_000);
    expect(format.sampleRate).toBe(16_000);
    expect(intent.handle).toHaveBeenCalledWith({
      satelliteId: "esp32-salon",
      text: "allume la lampe du salon",
    });
    expect(tts.synthesize).toHaveBeenCalledWith("Lampe salon allumée.");
    expect(sink.types()).toEqual(["listening", "transcript", "reply", "tts.start", "tts.end"]);
    const start = sink.json.find((m) => m.type === "tts.start");
    // 1 s at 22.05 kHz resampled to 16 kHz, s16le mono.
    expect(start).toMatchObject({
      sampleRate: 16_000,
      encoding: "pcm_s16le",
      channels: 1,
      bytes: 32_000,
    });
    expect(sink.audio.reduce((n, c) => n + c.byteLength, 0)).toBe(32_000);
    expect(sink.audio.every((c) => c.byteLength <= 4_000)).toBe(true);
    expect(session.state).toBe("idle");
  });

  it("replies in text only when the satellite has no speaker", async () => {
    const sink = new RecordingSink();
    const tts = makeTts();
    const session = new SatelliteVoiceSession({
      satelliteId: "esp32-mic-only",
      sink,
      stt: { transcribe: () => Promise.resolve("quelle heure") },
      tts,
      intent: { handle: () => Promise.resolve({ reply: "Il est midi." }) },
      serverEndOfSpeech: false,
    });
    session.wake();
    void session.pushAudio(tone(500));
    await session.endUtterance();
    expect(sink.types()).toEqual(["listening", "transcript", "reply"]);
    expect(tts.synthesize).not.toHaveBeenCalled();
    expect(sink.audio).toHaveLength(0);
  });

  it("ignores audio outside a listening turn and caps the utterance length", async () => {
    const sink = new RecordingSink();
    const transcribe = vi.fn(() => Promise.resolve("x"));
    const stt = { transcribe };
    const session = new SatelliteVoiceSession({
      satelliteId: "s",
      sink,
      stt,
      intent: { handle: () => Promise.resolve({ reply: "ok" }) },
      maxUtteranceMs: 300,
      serverEndOfSpeech: false,
    });
    expect(session.pushAudio(tone(200))).toBeUndefined();
    session.wake();
    void session.pushAudio(tone(200));
    await session.pushAudio(tone(200));
    const [audio] = stt.transcribe.mock.calls[0] as unknown as [Uint8Array];
    expect(audio.byteLength).toBe(9_600);
  });

  it("detects end of speech server-side after trailing silence", async () => {
    const sink = new RecordingSink();
    const stt = { transcribe: vi.fn(() => Promise.resolve("éteins tout")) };
    const session = new SatelliteVoiceSession({
      satelliteId: "s",
      sink,
      stt,
      intent: { handle: () => Promise.resolve({ reply: "ok" }) },
    });
    session.wake();
    for (let i = 0; i < 10; i += 1) void session.pushAudio(tone(50));
    let finished: Promise<void> | undefined;
    for (let i = 0; i < 40 && finished === undefined; i += 1) {
      finished = session.pushAudio(new Uint8Array(1_600));
    }
    expect(finished).toBeDefined();
    await finished;
    expect(stt.transcribe).toHaveBeenCalledTimes(1);
  });

  it("reports an error frame when STT fails, without leaking details", async () => {
    const sink = new RecordingSink();
    const session = new SatelliteVoiceSession({
      satelliteId: "s",
      sink,
      stt: { transcribe: async () => Promise.reject(new Error("/secret/path missing")) },
      intent: { handle: () => Promise.resolve({ reply: "ok" }) },
      serverEndOfSpeech: false,
    });
    session.wake();
    void session.pushAudio(tone(500));
    await session.endUtterance();
    const error = sink.json.find((m) => m.type === "error");
    expect(error).toMatchObject({ code: "TURN_FAILED" });
    expect(JSON.stringify(error)).not.toContain("/secret/path");
  });
});

describe("PCM helpers and whisper adapter", () => {
  it("resamples and writes a valid WAV header", () => {
    expect(resamplePcm16(new Uint8Array(44_100 * 2), 22_050, 16_000).byteLength).toBe(64_000);
    const wav = wavFromPcm16(new Uint8Array(320), 16_000);
    expect(Buffer.from(wav.subarray(0, 4)).toString("ascii")).toBe("RIFF");
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16_000);
  });

  it("transcribes through a scratch WAV that is deleted afterwards", async () => {
    const process = new FakeProcess();
    process.available.add("whisper-cli");
    process.outputs.set("whisper-cli", "allume la télé\n");
    const files = new FakeFiles();
    const scratch = new AudioScratch({
      files,
      directory: "/tmp/nexus-audio",
      newName: () => "turn.wav",
    });
    const writes: string[] = [];
    const stt = new WhisperBufferTranscriber({
      process,
      scratch,
      modelPath: "/models/ggml-base.bin",
      language: "fr",
      writeBinary: (path) => {
        writes.push(path);
        files.files.set(path, 1_000);
        return Promise.resolve();
      },
    });
    const text = await stt.transcribe(tone(200), {
      sampleRate: 16_000,
      channels: 1,
      encoding: "pcm_s16le",
    });
    expect(text).toBe("allume la télé");
    expect(writes).toEqual(["/tmp/nexus-audio/turn.wav"]);
    expect(process.runs[0]?.args).toEqual(
      expect.arrayContaining([
        "-m",
        "/models/ggml-base.bin",
        "-f",
        "/tmp/nexus-audio/turn.wav",
        "-l",
        "fr",
      ]),
    );
    expect(files.files.has("/tmp/nexus-audio/turn.wav")).toBe(false);
  });
});
