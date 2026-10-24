/**
 * Selectable local voices catalog and configuration.
 *
 * Provides typed definitions for on-device Piper speech models across supported languages.
 */

export interface LocalVoiceDefinition {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly gender: "female" | "male" | "neutral";
  readonly quality: "low" | "medium" | "high";
  readonly sampleRate: number;
  readonly modelFilename: string;
}

export const LOCAL_VOICES_CATALOG: readonly LocalVoiceDefinition[] = [
  {
    id: "en_US-lessac-medium",
    name: "Lessac (English - US)",
    language: "en-US",
    gender: "female",
    quality: "medium",
    sampleRate: 22050,
    modelFilename: "en_US-lessac-medium.onnx",
  },
  {
    id: "en_US-amy-medium",
    name: "Amy (English - US)",
    language: "en-US",
    gender: "female",
    quality: "medium",
    sampleRate: 22050,
    modelFilename: "en_US-amy-medium.onnx",
  },
  {
    id: "en_GB-alan-medium",
    name: "Alan (English - UK)",
    language: "en-GB",
    gender: "male",
    quality: "medium",
    sampleRate: 22050,
    modelFilename: "en_GB-alan-medium.onnx",
  },
  {
    id: "fr_FR-siwis-medium",
    name: "Siwis (French)",
    language: "fr-FR",
    gender: "female",
    quality: "medium",
    sampleRate: 22050,
    modelFilename: "fr_FR-siwis-medium.onnx",
  },
  {
    id: "de_DE-thorsten-medium",
    name: "Thorsten (German)",
    language: "de-DE",
    gender: "male",
    quality: "medium",
    sampleRate: 22050,
    modelFilename: "de_DE-thorsten-medium.onnx",
  },
  {
    id: "es_ES-carlfm-medium",
    name: "Carlfm (Spanish)",
    language: "es-ES",
    gender: "male",
    quality: "medium",
    sampleRate: 22050,
    modelFilename: "es_ES-carlfm-medium.onnx",
  },
] as const;

export interface VoiceSettings {
  voiceId: string;
  lengthScale: number; // 0.5 to 2.0 (smaller = faster)
  pitchShift: number; // -12 to +12 semitones
}

export class VoiceManager {
  readonly #voices = new Map<string, LocalVoiceDefinition>();
  #currentVoiceId: string;
  #settings: VoiceSettings;

  constructor(options?: {
    customVoices?: readonly LocalVoiceDefinition[];
    defaultVoiceId?: string;
  }) {
    for (const v of LOCAL_VOICES_CATALOG) {
      this.#voices.set(v.id, v);
    }
    if (options?.customVoices) {
      for (const v of options.customVoices) {
        this.#voices.set(v.id, v);
      }
    }

    const defaultId = options?.defaultVoiceId ?? "en_US-lessac-medium";
    this.#currentVoiceId = this.#voices.has(defaultId) ? defaultId : "en_US-lessac-medium";
    this.#settings = {
      voiceId: this.#currentVoiceId,
      lengthScale: 1.0,
      pitchShift: 0,
    };
  }

  get currentVoice(): LocalVoiceDefinition {
    const v = this.#voices.get(this.#currentVoiceId);
    if (!v) throw new Error(`Active voice ${this.#currentVoiceId} not found.`);
    return v;
  }

  get settings(): Readonly<VoiceSettings> {
    return { ...this.#settings };
  }

  setVoice(voiceId: string): void {
    if (!this.#voices.has(voiceId)) {
      throw new Error(`Voice ${voiceId} is not in catalog.`);
    }
    this.#currentVoiceId = voiceId;
    this.#settings.voiceId = voiceId;
  }

  setLengthScale(scale: number): void {
    this.#settings.lengthScale = Math.max(0.5, Math.min(2.0, scale));
  }

  listVoices(): readonly LocalVoiceDefinition[] {
    return Array.from(this.#voices.values());
  }

  getVoicesByLanguage(langPrefix: string): LocalVoiceDefinition[] {
    return Array.from(this.#voices.values()).filter((v) =>
      v.language.toLowerCase().startsWith(langPrefix.toLowerCase()),
    );
  }
}
