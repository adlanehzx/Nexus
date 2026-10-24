/**
 * Local audio noise reduction and spectral gating filter.
 *
 * ## Principles
 * 1. Attenuates background rumble, HVAC hum, and steady fan noise.
 * 2. High-pass filter removes sub-80Hz low-frequency noise.
 * 3. Soft noise gate suppresses stationary noise during inter-word pauses.
 */

export interface NoiseFilterOptions {
  /** High-pass cutoff frequency in Hz (default: 80Hz). */
  highPassCutoffHz?: number;
  /** Gate threshold RMS (default: 0.015). */
  gateThresholdRms?: number;
  /** Gate attenuation factor when closed (0.0 = silent, 1.0 = pass-through). */
  attenuationFactor?: number;
}

export class AudioNoiseReducer {
  readonly #highPassCutoffHz: number;
  readonly #gateThresholdRms: number;
  readonly #attenuationFactor: number;

  #prevInput = 0;
  #prevOutput = 0;

  constructor(options?: NoiseFilterOptions) {
    this.#highPassCutoffHz = options?.highPassCutoffHz ?? 80;
    this.#gateThresholdRms = options?.gateThresholdRms ?? 0.015;
    this.#attenuationFactor = options?.attenuationFactor ?? 0.1;
  }

  /**
   * Applies high-pass DC-blocking and noise gating to a buffer of float32 samples.
   * Returns a new cleaned Float32Array without mutating input.
   */
  process(samples: Float32Array, sampleRate = 16000): Float32Array {
    if (samples.length === 0) return new Float32Array(0);

    const output = new Float32Array(samples.length);

    // 1. Calculate frame RMS energy to decide gate state
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i] ?? 0;
      sumSquares += s * s;
    }
    const rms = Math.sqrt(sumSquares / samples.length);
    const gateOpen = rms >= this.#gateThresholdRms;
    const gain = gateOpen ? 1.0 : this.#attenuationFactor;

    // 2. High-pass filter coefficient (RC filter formula)
    const dt = 1.0 / sampleRate;
    const rc = 1.0 / (2 * Math.PI * this.#highPassCutoffHz);
    const alpha = rc / (rc + dt);

    for (let i = 0; i < samples.length; i++) {
      const currentInput = samples[i] ?? 0;
      // High-pass filter: y[i] = alpha * (y[i-1] + x[i] - x[i-1])
      const filtered = alpha * (this.#prevOutput + currentInput - this.#prevInput);
      this.#prevInput = currentInput;
      this.#prevOutput = filtered;

      output[i] = filtered * gain;
    }

    return output;
  }
}
