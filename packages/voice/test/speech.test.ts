import { describe, expect, it } from "vitest";
import { PiperSpeech } from "../src/piper.js";
import { VoiceUnavailableError } from "../src/whisper.js";
import { FakeProcess } from "./fakes.js";

const VOICE = "/srv/nexus-user/.nexus/voices/en_US-lessac-medium.onnx";

/** Waits until synthesis starts. */
async function untilSpeaking(piper: PiperSpeech): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (piper.speaking) return;
    await Promise.resolve();
  }
  throw new Error("synthesis never started");
}

function speech() {
  const process = new FakeProcess();
  process.available.add("piper").add("aplay");
  const piper = new PiperSpeech({ process, modelPath: VOICE, lengthScale: 1 });
  return { piper, process };
}

describe("availability", () => {
  it("identifies missing binary and remedy", async () => {
    const { piper, process } = speech();
    process.available.delete("piper");
    const availability = await piper.availability();
    expect(availability.ok).toBe(false);
    expect(availability.remedy).toContain("Piper");
  });

  it("identifies missing audio player", async () => {
    const { piper, process } = speech();
    process.available.delete("aplay");
    expect((await piper.availability()).reason).toContain("aplay");
  });

  it("fails early when dependencies are missing", async () => {
    const { piper, process } = speech();
    process.available.delete("piper");
    await expect(piper.speak("Hello")).rejects.toBeInstanceOf(VoiceUnavailableError);
  });
});

describe("speaking", () => {
  it("pipes text to standard input without creating disk files", async () => {
    const { piper, process } = speech();
    await piper.speak("Three important emails.");

    const synthesis = process.of("piper")[0];
    expect(synthesis?.stdin).toBe("Three important emails.");
    expect(synthesis?.args).toContain("--output_raw");
    expect(synthesis?.args.some((arg) => arg.endsWith(".wav"))).toBe(false);
  });

  it("starts audio player with format matching Piper output", async () => {
    const { piper, process } = speech();
    await piper.speak("Hello");
    const player = process.of("aplay")[0];
    expect(player?.args).toEqual(expect.arrayContaining(["-r", "22050", "-f", "S16_LE"]));
  });

  it("replaces active utterance instead of speaking over itself", async () => {
    const { piper, process } = speech();
    process.longRunning.add("piper").add("aplay");

    const first = piper.speak("First sentence");
    await untilSpeaking(piper);
    const second = piper.speak("Second sentence");
    await first;

    expect(process.of("piper")[0]?.killed).toBe(true);
    expect(process.of("piper")).toHaveLength(2);
    expect(process.of("piper")[1]?.killed).toBe(false);

    await piper.stop();
    await second;
  });
});

describe("interruption", () => {
  it("terminates synthesis and audio player processes immediately", async () => {
    const { piper, process } = speech();
    process.longRunning.add("piper").add("aplay");

    const speaking = piper.speak("A long sentence");
    await untilSpeaking(piper);
    await piper.stop();
    await speaking;

    expect(process.of("piper")[0]?.killed).toBe(true);
    expect(process.of("aplay")[0]?.killed).toBe(true);
  });

  it("marks sentence as interrupted without throwing", async () => {
    const { piper, process } = speech();
    process.longRunning.add("piper").add("aplay");

    const speaking = piper.speak("A long sentence");
    await untilSpeaking(piper);
    await piper.stop();
    const outcome = await speaking;

    expect(outcome.interrupted).toBe(true);
    expect(piper.interrupted).toBe(true);
  });

  it("marks nothing interrupted when sentence completes normally", async () => {
    const { piper } = speech();
    const outcome = await piper.speak("Short sentence");
    expect(outcome.interrupted).toBe(false);
  });

  it("stopping while idle does nothing", async () => {
    const { piper, process } = speech();
    await piper.stop();
    expect(process.runs).toHaveLength(0);
    expect(piper.interrupted).toBe(false);
  });
});
