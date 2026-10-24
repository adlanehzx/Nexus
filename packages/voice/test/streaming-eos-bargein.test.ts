import { describe, expect, it, vi } from "vitest";
import {
  AudioStreamingSession,
  DEFAULT_ACOUSTIC_PROFILES,
  type AudioFrame,
} from "../src/streaming.js";

describe("Bidirectional Audio Streaming, Barge-In and EOS Detection", () => {
  it("detects barge-in when user speaks during assistant playback", () => {
    const onBargeIn = vi.fn();
    const session = new AudioStreamingSession({
      profile: DEFAULT_ACOUSTIC_PROFILES.desktop,
      onBargeIn,
    });

    session.startSpeaking();
    expect(session.state).toBe("speaking");

    // 1. Silent/low energy frame while speaking -> no barge-in
    const quietSamples = new Float32Array(320).fill(0.01);
    const frameQuiet: AudioFrame = {
      samples: quietSamples,
      sampleRate: 16000,
      timestamp: 1000,
    };
    const quietRes = session.processMicrophoneFrame(frameQuiet);
    expect(quietRes.bargeInTriggered).toBe(false);
    expect(onBargeIn).not.toHaveBeenCalled();

    // 2. Loud user speech frame (energy > bargeInEnergyThreshold 0.15) -> barge-in triggered
    const speechSamples = new Float32Array(320).fill(0.35);
    const frameSpeech: AudioFrame = {
      samples: speechSamples,
      sampleRate: 16000,
      timestamp: 1020,
    };
    const speechRes = session.processMicrophoneFrame(frameSpeech);
    expect(speechRes.bargeInTriggered).toBe(true);
    expect(session.state).toBe("interrupted");
    expect(onBargeIn).toHaveBeenCalledTimes(1);
  });

  it("detects calibrated End-of-Speech (EOS) after turn speech finishes", () => {
    const onEndOfSpeech = vi.fn();
    const session = new AudioStreamingSession({
      profile: DEFAULT_ACOUSTIC_PROFILES.satellite, // 1000ms silence threshold
      onEndOfSpeech,
    });

    session.startListening();
    expect(session.state).toBe("listening");

    // User speaks for 200ms (10 frames of 20ms at 16kHz = 320 samples)
    const speechSamples = new Float32Array(320).fill(0.2);
    for (let i = 0; i < 10; i++) {
      session.processMicrophoneFrame({
        samples: speechSamples,
        sampleRate: 16000,
        timestamp: 1000 + i * 20,
      });
    }

    // Now silence: each frame is 20ms (320 samples / 16000 = 0.02s = 20ms)
    // 50 frames of silence = 1000ms silence
    const silenceSamples = new Float32Array(320).fill(0.005);
    for (let i = 0; i < 49; i++) {
      const res = session.processMicrophoneFrame({
        samples: silenceSamples,
        sampleRate: 16000,
        timestamp: 1200 + i * 20,
      });
      expect(res.endOfSpeechTriggered).toBe(false);
    }

    // 50th silence frame hits the 1000ms EOS threshold
    const finalRes = session.processMicrophoneFrame({
      samples: silenceSamples,
      sampleRate: 16000,
      timestamp: 1200 + 49 * 20,
    });
    expect(finalRes.endOfSpeechTriggered).toBe(true);
    expect(session.state).toBe("idle");
    expect(onEndOfSpeech).toHaveBeenCalledTimes(1);
  });

  it("closes microphone stream cleanly on error or termination", () => {
    const session = new AudioStreamingSession({});
    session.startListening();
    expect(session.isClosed).toBe(false);

    session.close();
    expect(session.isClosed).toBe(true);
    expect(session.state).toBe("closed");

    // Processing frames on closed session returns zero energy and does not throw
    const frame: AudioFrame = {
      samples: new Float32Array(100).fill(0.5),
      sampleRate: 16000,
      timestamp: 2000,
    };
    const res = session.processMicrophoneFrame(frame);
    expect(res.isSpeech).toBe(false);
    expect(res.bargeInTriggered).toBe(false);

    // Attempting to reopen closed session throws
    expect(() => session.startListening()).toThrowError("closed audio stream");
  });
});
