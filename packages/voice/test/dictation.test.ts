import { describe, expect, it } from "vitest";
import { AudioScratch } from "../src/scratch.js";
import { VoiceUnavailableError, WhisperDictation, cleanTranscript } from "../src/whisper.js";
import { FakeClock, FakeFiles, FakeProcess } from "./fakes.js";

const MODEL = "/srv/nexus-user/.nexus/models/ggml-base.bin";

function dictation(options: { segmentMs?: number; maxListeningMs?: number } = {}) {
  const process = new FakeProcess();
  const files = new FakeFiles();
  const clock = new FakeClock();

  process.available.add("whisper-cli").add("arecord");
  files.files.set(MODEL, 142_000_000);
  process.longRunning.add("arecord");
  process.outputs.set("whisper-cli", "Hello, organize my emails.");

  const scratch = new AudioScratch({
    files,
    directory: "/tmp/nexus-audio",
    newName: () => "dictation.wav",
  });

  const whisper = new WhisperDictation({
    process,
    files,
    clock,
    scratch,
    modelPath: MODEL,
    language: "en",
    ...options,
  });
  return { whisper, process, files, clock };
}

describe("availability", () => {
  it("identifies missing binary and remedy", async () => {
    const { whisper, process } = dictation();
    process.available.delete("whisper-cli");
    const availability = await whisper.availability();
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain("whisper-cli");
    expect(availability.remedy).toContain("whisper.cpp");
  });

  it("distinguishes missing model from missing binary", async () => {
    const { whisper, files } = dictation();
    files.files.delete(MODEL);
    const availability = await whisper.availability();
    expect(availability.reason).toContain("model");
    expect(availability.remedy).toContain(MODEL);
  });

  it("distinguishes missing audio recorder", async () => {
    const { whisper, process } = dictation();
    process.available.delete("arecord");
    expect((await whisper.availability()).reason).toContain("arecord");
  });

  it("refuses to start when dependencies are missing", async () => {
    const { whisper, process } = dictation();
    process.available.delete("whisper-cli");
    await expect(whisper.start()).rejects.toBeInstanceOf(VoiceUnavailableError);
    expect(whisper.listening).toBe(false);
  });
});

describe("listening", () => {
  it("opens microphone at 16 kHz mono matching whisper requirements", async () => {
    const { whisper, process, files } = dictation({ maxListeningMs: 1 });
    files.files.set("/tmp/nexus-audio/dictation.wav", 64_000);
    await whisper.start();

    const recording = process.of("arecord")[0];
    expect(recording?.args).toContain("16000");
    expect(recording?.args).toContain("S16_LE");
    expect(recording?.args).toContain("/tmp/nexus-audio/dictation.wav");
  });

  it("emits partial transcriptions progressively", async () => {
    const { whisper, files } = dictation({ segmentMs: 2_000, maxListeningMs: 6_000 });
    files.files.set("/tmp/nexus-audio/dictation.wav", 64_000);

    const partials: string[] = [];
    await whisper.start({ onPartial: (text) => partials.push(text) });
    expect(partials.length).toBeGreaterThanOrEqual(1);
    expect(partials[0]).toBe("Hello, organize my emails.");
  });

  it("does not run whisper on WAV containing only headers", async () => {
    const { whisper, process, files } = dictation({ segmentMs: 1, maxListeningMs: 3 });
    files.files.set("/tmp/nexus-audio/dictation.wav", 44);
    await whisper.start();
    expect(process.of("whisper-cli")).toHaveLength(0);
  });

  it("stops microphone upon maximum duration limit and preserves audio", async () => {
    const { whisper, process, files } = dictation({ segmentMs: 1_000, maxListeningMs: 2_000 });
    files.files.set("/tmp/nexus-audio/dictation.wav", 64_000);
    await whisper.start();

    expect(process.of("arecord")[0]?.killed).toBe(true);
    expect(whisper.listening).toBe(false);
    const result = await whisper.stop();
    expect(result.text).toContain("Hello");
  });

  it("passes language and model flags without writing output files", async () => {
    const { whisper, process, files } = dictation({ segmentMs: 1, maxListeningMs: 3 });
    files.files.set("/tmp/nexus-audio/dictation.wav", 64_000);
    await whisper.start();

    const run = process.of("whisper-cli")[0];
    expect(run?.args).toEqual(
      expect.arrayContaining(["-m", MODEL, "-f", "/tmp/nexus-audio/dictation.wav", "-l", "en"]),
    );
    expect(run?.args.some((arg) => arg.startsWith("--output"))).toBe(false);
  });

  it("deletes the recording when listening ends", async () => {
    const { whisper, files } = dictation({ segmentMs: 1, maxListeningMs: 2 });
    files.files.set("/tmp/nexus-audio/dictation.wav", 64_000);
    await whisper.start();
    expect(files.files.has("/tmp/nexus-audio/dictation.wav")).toBe(false);
    expect(files.removals).toContain("/tmp/nexus-audio/dictation.wav");
  });
});

describe("cancellation", () => {
  it("discards transcription without returning it", async () => {
    const { whisper, files } = dictation({ segmentMs: 1_000, maxListeningMs: 5_000 });
    files.files.set("/tmp/nexus-audio/dictation.wav", 64_000);
    await whisper.start();

    await whisper.cancel();
    const result = await whisper.stop();
    expect(result.text).toBe("");
    expect(result.segments).toEqual([]);
  });

  it("closes the microphone upon cancellation", async () => {
    const { whisper, process, files } = dictation({ segmentMs: 1_000, maxListeningMs: 5_000 });
    files.files.set("/tmp/nexus-audio/dictation.wav", 64_000);
    await whisper.start();
    await whisper.cancel();
    expect(process.of("arecord")[0]?.killed).toBe(true);
    expect(whisper.listening).toBe(false);
  });
});

describe("whisper output cleanup", () => {
  it("strips diagnostic lines and noise tags", () => {
    const raw = [
      "whisper_init_from_file_with_params_no_state: loading model",
      "[00:00:00.000 --> 00:00:02.000]",
      " Hello, organize my emails.",
      "(silence)",
      "",
    ].join("\n");
    expect(cleanTranscript(raw)).toBe("Hello, organize my emails.");
  });

  it("returns empty string when output is pure silence/noise", () => {
    expect(cleanTranscript("(silence)\n(music)\n")).toBe("");
    expect(cleanTranscript("")).toBe("");
  });

  it("joins multiple spoken lines", () => {
    expect(cleanTranscript("Hello.\nHow are you?")).toBe("Hello. How are you?");
  });
});
