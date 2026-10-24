import { describe, expect, it } from "vitest";
import { SpeakerEnrollmentError, SpeakerIdentifier } from "../src/speaker.js";

describe("Speaker Identification and Enrollment", () => {
  it("enrolls speaker, extracts voiceprint, and identifies matching audio", () => {
    const identifier = new SpeakerIdentifier({ matchThreshold: 0.8 });

    // Generate 2 seconds of mock audio at 16kHz with distinct harmonic pattern
    const sampleRate = 16000;
    const len = sampleRate * 2;
    const speakerASamples = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      speakerASamples[i] = Math.sin(i * 0.05) * 0.5 + Math.sin(i * 0.1) * 0.25;
    }

    const profile = identifier.enrollSpeaker({
      id: "spk_adlane",
      name: "Adlane",
      audioSamples: speakerASamples,
      sampleRate,
    });

    expect(profile.id).toBe("spk_adlane");
    expect(profile.voiceprint.length).toBe(16);
    expect(identifier.enrolledCount).toBe(1);

    // Identify with audio from same harmonic pattern
    const testSamplesA = new Float32Array(sampleRate);
    for (let i = 0; i < sampleRate; i++) {
      testSamplesA[i] = Math.sin(i * 0.05) * 0.4 + Math.sin(i * 0.1) * 0.2;
    }

    const matchA = identifier.identifySpeaker(testSamplesA);
    expect(matchA.matched).toBe(true);
    expect(matchA.speakerId).toBe("spk_adlane");
    expect(matchA.confidence).toBeGreaterThan(0.9);

    // Audio from completely different speaker frequency pattern (high pitch)
    const testSamplesB = new Float32Array(sampleRate);
    for (let i = 0; i < sampleRate; i++) {
      testSamplesB[i] = Math.sin(i * 0.8) * 0.4;
    }

    const matchB = identifier.identifySpeaker(testSamplesB);
    expect(matchB.matched).toBe(false);
  });

  it("fails enrollment on audio that is too short", () => {
    const identifier = new SpeakerIdentifier();
    const shortSamples = new Float32Array(16000 * 0.5); // 0.5s instead of >= 1.5s

    expect(() =>
      identifier.enrollSpeaker({
        id: "spk_short",
        name: "Too Short",
        audioSamples: shortSamples,
        sampleRate: 16000,
      }),
    ).toThrowError(SpeakerEnrollmentError);
  });

  it("supports explicit and permanent profile deletion", () => {
    const identifier = new SpeakerIdentifier();
    const samples = new Float32Array(16000 * 2).fill(0.3);

    identifier.enrollSpeaker({
      id: "spk_to_delete",
      name: "Temporary User",
      audioSamples: samples,
      sampleRate: 16000,
    });
    expect(identifier.getProfile("spk_to_delete")).toBeDefined();

    const deleted = identifier.deleteSpeaker("spk_to_delete");
    expect(deleted).toBe(true);
    expect(identifier.getProfile("spk_to_delete")).toBeUndefined();
    expect(identifier.enrolledCount).toBe(0);
  });
});
