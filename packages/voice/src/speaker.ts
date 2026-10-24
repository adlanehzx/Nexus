import { AppError } from "@nexus/shared";

/**
 * Local Speaker Identification and Voice Biometric Profile Manager.
 *
 * ## Principles
 * 1. Explicit enrollment and explicit permanent deletion.
 * 2. Zero raw audio retention: audio frames are converted to compact mathematical fingerprints, then discarded.
 * 3. Never used as the sole factor for sensitive/irreversible operations.
 */

export interface SpeakerProfile {
  readonly id: string;
  readonly name: string;
  readonly enrolledAt: number;
  readonly voiceprint: readonly number[];
  readonly sampleCount: number;
}

export class SpeakerEnrollmentError extends AppError {
  readonly code = "SPEAKER_ENROLLMENT_ERROR";
  readonly httpStatus = 400;

  constructor(reason: string) {
    super({
      message: `Speaker enrollment failed: ${reason}`,
      userMessage: `Could not enroll voice profile: ${reason}`,
    });
  }
}

export class SpeakerIdentifier {
  readonly #profiles = new Map<string, SpeakerProfile>();
  readonly #matchThreshold: number;

  constructor(options?: { matchThreshold?: number }) {
    // Cosine similarity threshold (0.0 to 1.0)
    this.#matchThreshold = options?.matchThreshold ?? 0.82;
  }

  get enrolledCount(): number {
    return this.#profiles.size;
  }

  /**
   * Enrolls a speaker from audio sample frames.
   * Extracts frequency distribution fingerprint and discards raw audio.
   */
  enrollSpeaker(params: {
    id: string;
    name: string;
    audioSamples: Float32Array;
    sampleRate: number;
    now?: number;
  }): SpeakerProfile {
    if (params.audioSamples.length < params.sampleRate * 1.5) {
      throw new SpeakerEnrollmentError("Enrollment audio must be at least 1.5 seconds long.");
    }

    const voiceprint = this.#extractVoiceprint(params.audioSamples);
    const profile: SpeakerProfile = {
      id: params.id,
      name: params.name,
      enrolledAt: params.now ?? Date.now(),
      voiceprint,
      sampleCount: params.audioSamples.length,
    };

    this.#profiles.set(params.id, profile);
    return profile;
  }

  /**
   * Identifies the speaker from an audio sample.
   */
  identifySpeaker(audioSamples: Float32Array): {
    matched: boolean;
    speakerId?: string | undefined;
    speakerName?: string | undefined;
    confidence: number;
  } {
    if (this.#profiles.size === 0 || audioSamples.length === 0) {
      return { matched: false, confidence: 0 };
    }

    const testPrint = this.#extractVoiceprint(audioSamples);
    let bestMatch: SpeakerProfile | undefined;
    let highestSim = -1;

    for (const profile of this.#profiles.values()) {
      const sim = this.#cosineSimilarity(testPrint, profile.voiceprint);
      if (sim > highestSim) {
        highestSim = sim;
        bestMatch = profile;
      }
    }

    const matched = highestSim >= this.#matchThreshold && bestMatch !== undefined;
    return {
      matched,
      ...(matched && bestMatch ? { speakerId: bestMatch.id, speakerName: bestMatch.name } : {}),
      confidence: Math.max(0, Math.min(1, Math.round(highestSim * 100) / 100)),
    };
  }

  /** Explicit and permanent deletion of speaker profile and biometric fingerprint. */
  deleteSpeaker(speakerId: string): boolean {
    return this.#profiles.delete(speakerId);
  }

  getProfile(speakerId: string): SpeakerProfile | undefined {
    return this.#profiles.get(speakerId);
  }

  listProfiles(): readonly SpeakerProfile[] {
    return Array.from(this.#profiles.values());
  }

  /** Extracts normalized acoustic fingerprint vector (spectral dynamics + zero crossings). */
  #extractVoiceprint(samples: Float32Array): number[] {
    const bands = 16;
    const bandSize = Math.floor(samples.length / (bands / 2));
    const vector: number[] = new Array(bands).fill(0);

    // First 8 bands: energy envelope and variance
    for (let b = 0; b < 8; b++) {
      let energy = 0;
      let zeroCrossings = 0;
      const start = b * bandSize;
      const end = Math.min(samples.length, start + bandSize);
      let prev = samples[start] ?? 0;

      for (let i = start; i < end; i++) {
        const s = samples[i] ?? 0;
        energy += Math.abs(s);
        if ((prev >= 0 && s < 0) || (prev < 0 && s >= 0)) {
          zeroCrossings++;
        }
        prev = s;
      }
      const count = Math.max(1, end - start);
      vector[b] = energy / count;
      vector[b + 8] = zeroCrossings / count;
    }

    // Normalize vector (L2 norm)
    let normSq = 0;
    for (const val of vector) normSq += val * val;
    const norm = Math.sqrt(normSq) || 1;
    return vector.map((v) => v / norm);
  }

  #cosineSimilarity(a: readonly number[], b: readonly number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const va = a[i] ?? 0;
      const vb = b[i] ?? 0;
      dot += va * vb;
      normA += va * va;
      normB += vb * vb;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}
