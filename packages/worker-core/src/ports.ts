import type { WorkerHealth } from "@nexus/protocol";

/**
 * Worker platform ports.
 *
 * Windows, macOS, Linux, and Android workers implement these three ports:
 *  - Credential signing
 *  - Health telemetry
 *  - Timer abstraction
 *
 * All protocol lifecycle, capability registration, execution, and backoff reside in worker-core.
 */

/**
 * Challenge signature provider.
 *
 * Private keys never leave the device: workers prove identity by signing
 * a one-time cryptographic nonce.
 */
export interface CredentialSigner {
  /** Signs a nonce string and returns base64 signature. */
  sign(nonce: string): Promise<string>;
}

/**
 * Health telemetry source reported to orchestrator.
 */
export interface HealthSource {
  snapshot(): WorkerHealth;
  /** Whether the worker currently has capacity to accept another task. */
  hasCapacity(): boolean;
  /**
   * Whether device performance is degraded (e.g. low battery, high thermal throttle).
   */
  isDegraded(): boolean;
}

/** Injectable timer interface for deterministic testing. */
export interface TimerPort {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export const systemTimers: TimerPort = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
