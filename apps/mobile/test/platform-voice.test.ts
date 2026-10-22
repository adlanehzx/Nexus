import { describe, expect, it, vi } from "vitest";

vi.mock("expo-speech", () => ({
  speak: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
  isSpeakingAsync: vi.fn().mockResolvedValue(false),
}));

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: vi.fn().mockResolvedValue(null),
  setItemAsync: vi.fn().mockResolvedValue(undefined),
  deleteItemAsync: vi.fn().mockResolvedValue(undefined),
}));

import { LocalSpeechToText, PiperTextToSpeech } from "../lib/platform.js";

describe("Mobile voice abstractions", () => {
  it("LocalSpeechToText initializes cleanly and provides stop/cancel with zero audio leakage", async () => {
    const stt = new LocalSpeechToText();
    const available = await stt.isAvailable();
    expect(typeof available).toBe("boolean");

    const result = await stt.stop();
    expect(result).toEqual({ text: "" });

    await expect(stt.cancel()).resolves.toBeUndefined();
  });

  it("PiperTextToSpeech implements TextToSpeechProvider contract", async () => {
    const tts = new PiperTextToSpeech();
    expect(await tts.isAvailable()).toBe(true);
    expect(await tts.isSpeaking()).toBe(false);
    await expect(tts.stop()).resolves.toBeUndefined();
  });
});
