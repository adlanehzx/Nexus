import { describe, expect, it } from "vitest";
import { HandsFreeConversation } from "../src/conversation.js";
import { PiperSpeech } from "../src/piper.js";
import { AudioScratch } from "../src/scratch.js";
import { WhisperDictation } from "../src/whisper.js";
import { FakeClock, FakeFiles, FakeProcess } from "./fakes.js";

const MODEL = "/models/base.bin";
const VOICE = "/voices/en.onnx";

function conversation(
  options: {
    heard?: string[];
    maxTurns?: number;
    maxDurationMs?: number;
    onSpeechDetected?: (listener: () => void) => () => void;
  } = {},
) {
  const process = new FakeProcess();
  const files = new FakeFiles();
  const clock = new FakeClock();
  process.available.add("whisper-cli").add("arecord").add("piper").add("aplay");
  files.files.set(MODEL, 1_000);
  process.longRunning.add("arecord");

  const heard = [...(options.heard ?? ["Organize my emails.", ""])];
  let turn = 0;
  process.outputs.set("whisper-cli", heard[0] ?? "");

  const dictation = new WhisperDictation({
    process,
    files,
    clock,
    scratch: new AudioScratch({ files, directory: "/tmp/a", newName: () => "d.wav" }),
    modelPath: MODEL,
    segmentMs: 1_000,
    maxListeningMs: 2_000,
  });
  const speech = new PiperSpeech({ process, modelPath: VOICE });

  const answers: string[] = [];
  const loop = new HandsFreeConversation({
    dictation,
    speech,
    clock,
    turnMs: 2_000,
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    ...(options.maxDurationMs === undefined ? {} : { maxDurationMs: options.maxDurationMs }),
    ...(options.onSpeechDetected === undefined
      ? {}
      : { onSpeechDetected: options.onSpeechDetected }),
    answer: (text) => {
      answers.push(text);
      turn += 1;
      process.outputs.set("whisper-cli", heard[turn] ?? "");
      return Promise.resolve(`Processed: ${text}`);
    },
  });

  process.effects.set("arecord", (args) => {
    const path = args.at(-1);
    if (path !== undefined) files.files.set(path, 64_000);
  });

  return { loop, process, files, clock, answers };
}

describe("single turn", () => {
  it("listens, answers, and speaks", async () => {
    const { loop, process, answers } = conversation();
    const outcome = await loop.run();

    expect(answers).toEqual(["Organize my emails."]);
    expect(outcome.turns).toHaveLength(1);
    expect(outcome.turns[0]?.answered).toContain("Processed:");
    expect(process.of("piper")[0]?.stdin).toContain("Processed:");
  });

  it("terminates on silence", async () => {
    const { loop } = conversation({ heard: [""] });
    const outcome = await loop.run();
    expect(outcome.stoppedBy).toBe("silence");
    expect(outcome.turns).toHaveLength(0);
  });
});

describe("conversation stops", () => {
  it("at turn limit", async () => {
    const { loop } = conversation({
      heard: ["one", "two", "three", "four"],
      maxTurns: 2,
    });
    const outcome = await loop.run();
    expect(outcome.stoppedBy).toBe("turn-limit");
    expect(outcome.turns).toHaveLength(2);
  });

  it("at duration limit", async () => {
    const { loop } = conversation({
      heard: ["one", "two", "three", "four", "five"],
      maxDurationMs: 5_000,
    });
    const outcome = await loop.run();
    expect(outcome.stoppedBy).toBe("duration-limit");
  });

  it("when stop is requested", async () => {
    const { loop } = conversation({ heard: ["one", "two", "three"] });
    const run = loop.run();
    loop.stop();
    const outcome = await run;
    expect(outcome.stoppedBy).toBe("requested");
  });

  it("closes microphone and voice output on exit in all cases", async () => {
    const { loop, process } = conversation({ heard: [""] });
    await loop.run();
    expect(process.of("arecord").every((run) => run.killed)).toBe(true);
    expect(loop.running).toBe(false);
  });

  it("cleans up resources even if answer throws", async () => {
    const process = new FakeProcess();
    const files = new FakeFiles();
    const clock = new FakeClock();
    process.available.add("whisper-cli").add("arecord").add("piper").add("aplay");
    files.files.set(MODEL, 1_000);
    process.longRunning.add("arecord");
    process.outputs.set("whisper-cli", "Do something.");
    files.files.set("/tmp/a/d.wav", 64_000);

    const loop = new HandsFreeConversation({
      dictation: new WhisperDictation({
        process,
        files,
        clock,
        scratch: new AudioScratch({ files, directory: "/tmp/a", newName: () => "d.wav" }),
        modelPath: MODEL,
        segmentMs: 1_000,
        maxListeningMs: 2_000,
      }),
      speech: new PiperSpeech({ process, modelPath: VOICE }),
      clock,
      turnMs: 2_000,
      answer: () => Promise.reject(new Error("agent failed")),
    });

    await expect(loop.run()).rejects.toThrow("agent failed");
    expect(process.of("arecord").every((run) => run.killed)).toBe(true);
    expect(loop.running).toBe(false);
  });
});

describe("voice interruption (barge-in)", () => {
  it("cuts off speech immediately when user begins speaking", async () => {
    let fire: (() => void) | undefined;
    const { loop, process } = conversation({
      heard: ["Tell me everything", ""],
      onSpeechDetected: (listener) => {
        fire = listener;
        return () => {
          fire = undefined;
        };
      },
    });
    process.longRunning.add("piper").add("aplay");

    const run = loop.run();
    for (let index = 0; index < 200 && fire === undefined; index += 1) {
      await Promise.resolve();
    }
    for (let index = 0; index < 200 && process.of("piper").length === 0; index += 1) {
      await Promise.resolve();
    }
    fire?.();
    const outcome = await run;

    expect(process.of("piper")[0]?.killed).toBe(true);
    expect(outcome.turns[0]?.interrupted).toBe(true);
  });

  it("disarms detection after the turn", async () => {
    let armed = 0;
    let disarmed = 0;
    const { loop } = conversation({
      heard: ["one", ""],
      onSpeechDetected: () => {
        armed += 1;
        return () => {
          disarmed += 1;
        };
      },
    });
    await loop.run();

    expect(armed).toBe(1);
    expect(disarmed).toBe(1);
  });

  it("completes speech normally without detector", async () => {
    const { loop } = conversation({ heard: ["one", ""] });
    const outcome = await loop.run();
    expect(outcome.turns[0]?.interrupted).toBe(false);
  });
});
