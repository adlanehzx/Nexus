import { describe, expect, it } from "vitest";
import { AudioNoiseReducer } from "../src/noise.js";
import { SpokenVoiceTranslator } from "../src/translation.js";
import { VoiceManager } from "../src/voices.js";

describe("Voices, Translation, and Noise Reduction", () => {
  it("manages catalog of local voices and parameters", () => {
    const manager = new VoiceManager();
    expect(manager.listVoices().length).toBeGreaterThanOrEqual(6);

    const frenchVoices = manager.getVoicesByLanguage("fr");
    expect(frenchVoices.length).toBeGreaterThanOrEqual(1);
    expect(frenchVoices[0]?.id).toBe("fr_FR-siwis-medium");

    manager.setVoice("fr_FR-siwis-medium");
    expect(manager.currentVoice.name).toContain("French");

    manager.setLengthScale(0.85); // 15% faster
    expect(manager.settings.lengthScale).toBe(0.85);

    expect(() => manager.setVoice("non_existent_voice")).toThrowError("not in catalog");
  });

  it("translates spoken utterance with local engine adapter", async () => {
    const mockTranslator = async (text: string, sourceLang: string, targetLang: string) => {
      if (sourceLang === "es" && targetLang === "en") {
        return { translatedText: "Hello, how can I help you?", confidence: 0.98 };
      }
      return { translatedText: text, confidence: 0.5 };
    };

    const translator = new SpokenVoiceTranslator(mockTranslator);
    const result = await translator.translateUtterance(
      "Hola, como puedo ayudarte",
      "es",
      "en",
    );

    expect(result.translatedText).toBe("Hello, how can I help you?");
    expect(result.sourceLanguage).toBe("es");
    expect(result.targetLanguage).toBe("en");
    expect(result.confidence).toBe(0.98);
  });

  it("reduces background rumble and noise via DC filter and soft gate", () => {
    const reducer = new AudioNoiseReducer({
      highPassCutoffHz: 80,
      gateThresholdRms: 0.05,
      attenuationFactor: 0.05,
    });

    // 1. Silent ambient noise frame (RMS = 0.01 < 0.05 gate threshold)
    const noisyAmbient = new Float32Array(320).fill(0.01);
    const attenuated = reducer.process(noisyAmbient);

    // Attenuated by ~95%
    expect(attenuated[10]).toBeLessThan(0.002);

    // 2. High energy speech frame (RMS = 0.3 >= 0.05 threshold)
    const speech = new Float32Array(320);
    for (let i = 0; i < 320; i++) {
      speech[i] = Math.sin(i * 0.2) * 0.4;
    }
    const passed = reducer.process(speech);
    // Speech passes through without being gated
    expect(Math.abs(passed[100] ?? 0)).toBeGreaterThan(0.05);
  });
});
