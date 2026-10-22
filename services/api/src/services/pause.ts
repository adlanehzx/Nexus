import { z } from "zod";
import { AppError } from "@nexus/shared";
import type { RuntimeConfigurationStore } from "./runtime-configuration.js";

/**
 * Global pause switch.
 *
 * ## What "pause" means, precisely
 *
 * **Reading continues, acting stops.** This is the only practical definition for a
 * personal assistant: we pause NEXUS because we do not want it to *do*
 * things — not because we want it to go blind. A paused agent
 * can still retrieve, summarize, and reply; it can no longer send,
 * write, execute, or purchase.
 *
 * Technically, this aligns exactly with the circuit-breaker that already
 * existed in `PermissionService`: `readOnly` rejects any tool with `LOW` or
 * higher risk, while permitting `SAFE`. The risk tier already provided the
 * right boundary; it only needed an actuation mechanism.
 *
 * ## Three key properties, and why each matters
 *
 * **It survives restarts.** A pause that forgets state is worse than no
 * pause: users believe NEXUS is stopped, it resumes, and no one is notified.
 * State is therefore persisted to disk using the same atomic write used by
 * the rest of the configuration.
 *
 * **It records a reason and a timestamp.** "Nothing is happening" is the most
 * expensive symptom to diagnose. An interface that displays "paused since
 * 14:02: meeting" turns a mystery into actionable information.
 *
 * **It cannot lock itself out.** Resuming is an action, and if pause
 * unconditionally rejected actions, it would prevent its own removal. The
 * resume route therefore does not check whether pause is active — it updates it.
 */

export const pauseStateSchema = z.object({
  paused: z.boolean(),
  /** Reason, as entered by the user. Never enforced. */
  reason: z.string().max(200).nullable(),
  /** Timestamp when paused, in ISO 8601. Null when not paused. */
  since: z.string().datetime().nullable(),
});

export type PauseState = z.infer<typeof pauseStateSchema>;

const RUNNING: PauseState = { paused: false, reason: null, since: null };

export class SystemPausedError extends AppError {
  readonly code = "SYSTEM_PAUSED";
  readonly httpStatus = 409;

  constructor(state: PauseState) {
    super({
      message: "NEXUS is paused",
      userMessage:
        state.reason === null
          ? "NEXUS is paused. Resume it to run actions."
          : `NEXUS is paused: ${state.reason}. Resume it to run actions.`,
      context: { since: state.since },
    });
  }
}

export interface PauseSwitchOptions {
  /**
   * Persistence. When omitted, pause state lives only in memory.
   *
   * This is appropriate for unit tests, but not in production: without
   * persistence, a restart would silently lift the pause.
   */
  store?: RuntimeConfigurationStore;
  now?: () => Date;
}

export class PauseSwitch {
  readonly #store: RuntimeConfigurationStore | undefined;
  readonly #now: () => Date;
  #state: PauseState = RUNNING;

  constructor(options: PauseSwitchOptions = {}) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Reads state from disk.
   *
   * Called on startup. Synchronous in subsequent usage — `paused` must respond
   * without awaiting, because it is checked on every authorization path
   * — hence this single explicit read at startup rather than disk access
   * per call.
   */
  async restore(): Promise<PauseState> {
    if (this.#store === undefined) return this.#state;
    const loaded = await this.#store.loadPause();
    if (loaded !== null) this.#state = loaded;
    return this.#state;
  }

  get state(): PauseState {
    return { ...this.#state };
  }

  get paused(): boolean {
    return this.#state.paused;
  }

  async set(paused: boolean, reason?: string): Promise<PauseState> {
    // Pausing what is already paused does not move the timestamp: we want to know
    // since when, not since the last click.
    if (paused && this.#state.paused) {
      if (reason !== undefined) {
        this.#state = { ...this.#state, reason };
        await this.#persist();
      }
      return this.state;
    }

    this.#state = paused
      ? { paused: true, reason: reason ?? null, since: this.#now().toISOString() }
      : RUNNING;
    await this.#persist();
    return this.state;
  }

  /** Throws `SystemPausedError` if NEXUS is paused. */
  assertRunning(): void {
    if (this.#state.paused) throw new SystemPausedError(this.#state);
  }

  async #persist(): Promise<void> {
    if (this.#store === undefined) return;
    await this.#store.savePause(this.#state);
  }
}
